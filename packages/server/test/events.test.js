import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { PluginRegistry } from '../src/lib/plugins/registry.js';
import { runPending } from '../src/worker/index.js';
import { enqueueExtraction } from '../src/worker/queue.js';
import { createEventBus } from '../src/lib/bus.js';

test('/api/events requires auth', async () => {
  const app = await startTestApp();
  try {
    const res = await fetch(`${app.base}/api/events`);
    assert.equal(res.status, 401);
    await res.body?.cancel();
  } finally {
    await app.close();
  }
});

test('SSE stream delivers a change event when the bus emits', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const res = await fetch(`${app.base}/api/events`, { headers: { cookie: app.cookieHeader() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Drain the initial ": connected" comment, then emit and read the event.
    await reader.read();
    app.events.emit('change', { type: 'extracted', versionId: 7 });

    let buf = '';
    for (let i = 0; i < 5 && !buf.includes('event: change'); i++) {
      const { value } = await reader.read();
      buf += decoder.decode(value, { stream: true });
    }
    assert.match(buf, /event: change/);
    assert.match(buf, /"versionId":7/);

    await reader.cancel();
  } finally {
    await app.close();
  }
});

test('uploading emits a change on the bus', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const changed = once(app.events, 'change');
    await app.upload('/api/files', { filename: 'a.txt', contentType: 'text/plain', body: 'hi' });
    const [detail] = await changed;
    assert.equal(detail.type, 'created');
  } finally {
    await app.close();
  }
});

test('the worker emits a change after finishing extraction', async () => {
  const dir = await (await import('node:fs/promises')).mkdtemp('/tmp/gemme-ev-');
  const db = openMemoryDatabase();
  const events = createEventBus();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  const blobStore = new BlobStore(dir);
  const { hash, size } = await blobStore.putBuffer(Buffer.from('hello'));
  db.exec('BEGIN');
  const a = db.prepare('INSERT INTO files (original_filename, created_by) VALUES (?, ?)').run('n.txt', userId);
  const v = db
    .prepare('INSERT INTO versions (file_id, content_hash, byte_size, mime_type) VALUES (?, ?, ?, ?)')
    .run(a.lastInsertRowid, hash, size, 'text/plain');
  db.prepare('UPDATE files SET current_version_id = ? WHERE id = ?').run(v.lastInsertRowid, a.lastInsertRowid);
  db.exec('COMMIT');

  enqueueExtraction(db, v.lastInsertRowid);
  const changed = once(events, 'change');
  await runPending(db, { blobStore, registry: new PluginRegistry(), events });
  const [detail] = await changed;
  assert.equal(detail.type, 'extracted');
  assert.equal(detail.versionId, v.lastInsertRowid);

  db.close();
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true });
});
