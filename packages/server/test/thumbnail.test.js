import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { DerivedStore } from '../src/lib/storage/derived.js';
import { runExtraction, runPending } from '../src/worker/index.js';
import { enqueueExtraction } from '../src/worker/queue.js';
import { startTestApp } from './helpers/server.js';
import { fakeRegistry } from './helpers/plugins.js';
import { createUser } from '../src/lib/auth/users.js';

// Thumbnails are a plugin `thumbnail` capability: one pre-generated image the
// worker stores in the derived store and records as `files.thumbnail_type`.

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-thumb-'));
  const db = openMemoryDatabase();
  const blobStore = new BlobStore(dir);
  const derivedStore = new DerivedStore(dir);
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  async function seed({ filename, mimeType, buffer }) {
    const { hash, size } = await blobStore.putBuffer(buffer);
    const a = db
      .prepare('INSERT INTO files (original_filename, content_hash, byte_size, mime_type, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(filename, hash, size, mimeType, userId);
    return { fileId: a.lastInsertRowid, hash };
  }
  return { db, blobStore, derivedStore, seed, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('extraction pre-generates the thumbnail and records thumbnail_type', async () => {
  const s = await setup();
  try {
    const { fileId } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    const res = await runExtraction(s.db, { blobStore: s.blobStore, derivedStore: s.derivedStore, registry: fakeRegistry() }, fileId);
    assert.equal(res.thumbnail, true);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM files WHERE id = ?').get(fileId).thumbnail_type, 'image/webp');
  } finally {
    await s.cleanup();
  }
});

test('no derivedStore => no thumbnail generated', async () => {
  const s = await setup();
  try {
    const { fileId } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    const res = await runExtraction(s.db, { blobStore: s.blobStore, registry: fakeRegistry() }, fileId);
    assert.equal(res.thumbnail, false);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM files WHERE id = ?').get(fileId).thumbnail_type, null);
  } finally {
    await s.cleanup();
  }
});

test('a file whose plugins have no thumbnail capability (text) gets none', async () => {
  const s = await setup();
  try {
    const { fileId } = await s.seed({ filename: 'n.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    const res = await runExtraction(s.db, { blobStore: s.blobStore, derivedStore: s.derivedStore, registry: fakeRegistry() }, fileId);
    assert.equal(res.thumbnail, false);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM files WHERE id = ?').get(fileId).thumbnail_type, null);
  } finally {
    await s.cleanup();
  }
});

async function drain(app) {
  await runPending(app.db, {
    blobStore: new BlobStore(app.dataDir),
    derivedStore: new DerivedStore(app.dataDir),
    registry: fakeRegistry(),
  });
}

test('HTTP: thumbnail served for images, 404 for text; list flags thumbnail_type', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const img = await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' });
    const txt = await app.upload('/api/files', { filename: 'n.txt', contentType: 'text/plain', body: 'hello' });
    await drain(app);

    const thumb = await app.get(`/api/files/${img.json.file.id}/thumbnail`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.res.headers.get('content-type'), 'image/webp');
    assert.equal(thumb.text, 'THUMB:image');

    assert.equal((await app.get(`/api/files/${txt.json.file.id}/thumbnail`)).status, 404);

    const list = await app.get('/api/files');
    const byName = Object.fromEntries(list.json.items.map((i) => [i.original_filename, i.thumbnail_type]));
    assert.equal(byName['p.png'], 'image/webp');
    assert.equal(byName['n.txt'], null);
  } finally {
    await app.close();
  }
});

async function seedImageApp(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
  const img = await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' });
  await drain(app);
  return img.json.file.id;
}

test('HTTP (production): thumbnails are immutable and support If-None-Match', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    const id = await seedImageApp(app);
    const thumb = await app.get(`/api/files/${id}/thumbnail`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.res.headers.get('cache-control'), /immutable/);
    const etag = thumb.res.headers.get('etag');
    assert.ok(etag);
    const revalidated = await app.get(`/api/files/${id}/thumbnail`, { headers: { 'if-none-match': etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.text, '');
  } finally {
    await app.close();
  }
});

test('HTTP (dev mode): thumbnails are never immutable', async () => {
  const app = await startTestApp({ dev: true, onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    const id = await seedImageApp(app);
    const thumb = await app.get(`/api/files/${id}/thumbnail`);
    assert.equal(thumb.status, 200);
    assert.doesNotMatch(thumb.res.headers.get('cache-control'), /immutable/);
    assert.match(thumb.res.headers.get('cache-control'), /no-cache/);
  } finally {
    await app.close();
  }
});
