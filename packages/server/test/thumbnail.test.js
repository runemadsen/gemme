import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { DerivedStore } from '../src/lib/storage/derived.js';
import { PluginRegistry } from '../src/lib/plugins/registry.js';
import { runExtraction, runPending } from '../src/worker/index.js';
import { enqueueExtraction } from '../src/worker/queue.js';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-thumb-'));
  const db = openMemoryDatabase();
  const blobStore = new BlobStore(dir);
  const derivedStore = new DerivedStore(dir);
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  async function seed({ filename, mimeType, buffer }) {
    const { hash, size } = await blobStore.putBuffer(buffer);
    db.exec('BEGIN');
    const a = db.prepare('INSERT INTO files (original_filename, created_by) VALUES (?, ?)').run(filename, userId);
    const v = db
      .prepare('INSERT INTO versions (file_id, content_hash, byte_size, mime_type) VALUES (?, ?, ?, ?)')
      .run(a.lastInsertRowid, hash, size, mimeType);
    db.prepare('UPDATE files SET current_version_id = ? WHERE id = ?').run(v.lastInsertRowid, a.lastInsertRowid);
    db.exec('COMMIT');
    return { versionId: v.lastInsertRowid, hash };
  }
  return { db, blobStore, derivedStore, seed, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const thumbPlugin = (id, bytes) => ({
  id,
  matches: (mime) => /^image\//.test(mime || ''),
  async extract() {
    return { metadata: [], thumbnail: { data: Buffer.from(bytes), contentType: 'image/webp' } };
  },
});

test('a produced thumbnail is written to the derived store and recorded on the version', async () => {
  const s = await setup();
  try {
    const { versionId, hash } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    const registry = new PluginRegistry().register(thumbPlugin('t', 'WEBP-A'));
    const res = await runExtraction(s.db, { blobStore: s.blobStore, derivedStore: s.derivedStore, registry }, versionId);

    assert.equal(res.thumbnail, true);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM versions WHERE id = ?').get(versionId).thumbnail_type, 'image/webp');
    assert.equal(s.derivedStore.hasThumb(hash, 'image/webp'), true);
  } finally {
    await s.cleanup();
  }
});

test('first plugin wins; later plugins see prior.thumbnail and can skip', async () => {
  const s = await setup();
  try {
    const { versionId, hash } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });

    const seen = [];
    const spy = {
      id: 'spy',
      matches: () => true,
      async extract({ prior }) {
        seen.push(prior.thumbnail);
        // Would produce its own, but should be ignored since first already won.
        return { metadata: [], thumbnail: { data: Buffer.from('WEBP-B'), contentType: 'image/webp' } };
      },
    };
    const registry = new PluginRegistry().register(thumbPlugin('first', 'WEBP-A')).register(spy);
    await runExtraction(s.db, { blobStore: s.blobStore, derivedStore: s.derivedStore, registry }, versionId);

    assert.deepEqual(seen, [true], 'the second plugin observed that a thumbnail already existed');
    const stored = await s.derivedStore.createThumbReadStream(hash, 'image/webp');
    const bytes = await new Promise((r) => {
      const c = [];
      stored.on('data', (x) => c.push(x)).on('end', () => r(Buffer.concat(c)));
    });
    assert.equal(bytes.toString(), 'WEBP-A', 'the first plugin’s thumbnail was kept');
  } finally {
    await s.cleanup();
  }
});

test('no derivedStore in context => no thumbnail target, none stored', async () => {
  const s = await setup();
  try {
    const { versionId } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    let targetSeen = 'unset';
    const probe = {
      id: 'probe',
      matches: () => true,
      async extract({ thumbnailTarget }) {
        targetSeen = thumbnailTarget;
        return { metadata: [] };
      },
    };
    const registry = new PluginRegistry().register(probe);
    const res = await runExtraction(s.db, { blobStore: s.blobStore, registry }, versionId);
    assert.equal(targetSeen, null, 'plugins get a null target when thumbnails cannot be persisted');
    assert.equal(res.thumbnail, false);
  } finally {
    await s.cleanup();
  }
});

test('HTTP: thumbnail served when present, 404 when absent; list flags it', async () => {
  const app = await startTestApp({ onVersionCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const img = await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' });
    const txt = await app.upload('/api/files', { filename: 'n.txt', contentType: 'text/plain', body: 'hello' });

    // Drain with a registry whose image plugin emits a thumbnail.
    const registry = new PluginRegistry().register(thumbPlugin('t', 'WEBP-A'));
    await runPending(app.db, {
      blobStore: new BlobStore(app.dataDir),
      derivedStore: new DerivedStore(app.dataDir),
      registry,
    });

    // Image file has a thumbnail
    const thumb = await app.get(`/api/files/${img.json.file.id}/thumbnail`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.res.headers.get('content-type'), 'image/webp');
    assert.equal(thumb.text, 'WEBP-A');

    // Text file has none
    assert.equal((await app.get(`/api/files/${txt.json.file.id}/thumbnail`)).status, 404);

    // list reflects thumbnail_type
    const list = await app.get('/api/files');
    const byName = Object.fromEntries(list.json.items.map((i) => [i.original_filename, i.thumbnail_type]));
    assert.equal(byName['p.png'], 'image/webp');
    assert.equal(byName['n.txt'], null);
  } finally {
    await app.close();
  }
});

// Image cache policy: version-pinned URLs are immutable (safe — a version is
// written once), bare "current" pointers always revalidate, and dev mode never
// sends immutable (so re-running extraction locally can't poison the cache).
async function seedImageApp(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
  const img = await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' });
  await runPending(app.db, {
    blobStore: new BlobStore(app.dataDir),
    derivedStore: new DerivedStore(app.dataDir),
    registry: new PluginRegistry().register(thumbPlugin('t', 'WEBP-A')),
  });
  const file = app.db.prepare('SELECT id, current_version_id FROM files WHERE id = ?').get(img.json.file.id);
  return file;
}

test('HTTP (production): version-pinned image URLs are immutable; bare pointers revalidate', async () => {
  const app = await startTestApp({ onVersionCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    const { id, current_version_id: vid } = await seedImageApp(app);

    // Version-pinned thumbnail + download → immutable (the bytes never change).
    const pinnedThumb = await app.get(`/api/files/${id}/versions/${vid}/thumbnail`);
    assert.equal(pinnedThumb.status, 200);
    assert.match(pinnedThumb.res.headers.get('cache-control'), /immutable/);
    const pinnedDl = await app.get(`/api/files/${id}/versions/${vid}/download`);
    assert.equal(pinnedDl.status, 200);
    assert.match(pinnedDl.res.headers.get('cache-control'), /immutable/);

    // Bare "current" pointers move, so they always revalidate against an ETag.
    const bareThumb = await app.get(`/api/files/${id}/thumbnail`);
    assert.equal(bareThumb.status, 200);
    assert.doesNotMatch(bareThumb.res.headers.get('cache-control'), /immutable/);
    assert.match(bareThumb.res.headers.get('cache-control'), /no-cache/);
    const etag = bareThumb.res.headers.get('etag');
    assert.ok(etag);
    const revalidated = await app.get(`/api/files/${id}/thumbnail`, { headers: { 'if-none-match': etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.text, '');
  } finally {
    await app.close();
  }
});

test('HTTP (dev mode): even version-pinned URLs are never immutable', async () => {
  const app = await startTestApp({ dev: true, onVersionCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    const { id, current_version_id: vid } = await seedImageApp(app);
    const thumb = await app.get(`/api/files/${id}/versions/${vid}/thumbnail`);
    assert.equal(thumb.status, 200);
    assert.doesNotMatch(thumb.res.headers.get('cache-control'), /immutable/);
    assert.match(thumb.res.headers.get('cache-control'), /no-cache/);
  } finally {
    await app.close();
  }
});
