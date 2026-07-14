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
import { rendererFor, thumbnailSpec, specSig } from '../src/lib/renditions.js';
import { startTestApp } from './helpers/server.js';
import { fakeRegistry } from './helpers/plugins.js';
import { createUser } from '../src/lib/auth/users.js';

// Thumbnails are now ordinary renditions: the renderer's `thumbnail` preset,
// pre-generated on extraction and served/cached like public transforms.

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

test('extraction pre-generates the thumbnail rendition and records thumbnail_type', async () => {
  const s = await setup();
  try {
    const { versionId, hash } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    const registry = fakeRegistry();
    const res = await runExtraction(s.db, { blobStore: s.blobStore, derivedStore: s.derivedStore, registry }, versionId);

    assert.equal(res.thumbnail, true);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM versions WHERE id = ?').get(versionId).thumbnail_type, 'image/webp');

    // The thumbnail is a variant keyed by the thumbnail preset's signature.
    const renderer = rendererFor(registry, 'image/png', 'p.png');
    const { spec, ext } = thumbnailSpec(renderer);
    assert.equal(s.derivedStore.hasVariant(hash, specSig(spec, ext), ext), true);
  } finally {
    await s.cleanup();
  }
});

test('config renditions.pregenerate produces extra variants that share the cache', async () => {
  const s = await setup();
  try {
    const { versionId, hash } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    const registry = fakeRegistry();
    await runExtraction(
      s.db,
      { blobStore: s.blobStore, derivedStore: s.derivedStore, registry, renditions: { pregenerate: ['w=1024.webp'] } },
      versionId
    );
    const renderer = rendererFor(registry, 'image/png', 'p.png');
    const spec = renderer.normalize({ w: '1024' });
    assert.equal(s.derivedStore.hasVariant(hash, specSig(spec, 'webp'), 'webp'), true);
  } finally {
    await s.cleanup();
  }
});

test('no derivedStore => no thumbnail generated', async () => {
  const s = await setup();
  try {
    const { versionId } = await s.seed({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('img') });
    const res = await runExtraction(s.db, { blobStore: s.blobStore, registry: fakeRegistry() }, versionId);
    assert.equal(res.thumbnail, false);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM versions WHERE id = ?').get(versionId).thumbnail_type, null);
  } finally {
    await s.cleanup();
  }
});

test('a file with no renderer (text) gets no thumbnail', async () => {
  const s = await setup();
  try {
    const { versionId } = await s.seed({ filename: 'n.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    const res = await runExtraction(s.db, { blobStore: s.blobStore, derivedStore: s.derivedStore, registry: fakeRegistry() }, versionId);
    assert.equal(res.thumbnail, false);
    assert.equal(s.db.prepare('SELECT thumbnail_type FROM versions WHERE id = ?').get(versionId).thumbnail_type, null);
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

test('HTTP: thumbnail served for images, 404 for non-images; list flags thumbnail_type', async () => {
  const app = await startTestApp({ onVersionCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const img = await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' });
    const txt = await app.upload('/api/files', { filename: 'n.txt', contentType: 'text/plain', body: 'hello' });
    await drain(app);

    const thumb = await app.get(`/api/files/${img.json.file.id}/thumbnail`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.res.headers.get('content-type'), 'image/webp');
    assert.match(thumb.text, /^RENDITION:webp:512x/);

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
  return app.db.prepare('SELECT id, current_version_id FROM files WHERE id = ?').get(img.json.file.id);
}

test('HTTP (production): version-pinned thumbnails are immutable; bare pointers revalidate', async () => {
  const app = await startTestApp({ onVersionCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    const { id, current_version_id: vid } = await seedImageApp(app);

    const pinnedThumb = await app.get(`/api/files/${id}/versions/${vid}/thumbnail`);
    assert.equal(pinnedThumb.status, 200);
    assert.match(pinnedThumb.res.headers.get('cache-control'), /immutable/);

    const bareThumb = await app.get(`/api/files/${id}/thumbnail`);
    assert.equal(bareThumb.status, 200);
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

test('HTTP (dev mode): even version-pinned thumbnails are never immutable', async () => {
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
