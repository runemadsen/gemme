import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { DerivedStore } from '../src/lib/storage/derived.js';
import { runPending } from '../src/worker/index.js';
import { enqueueExtraction } from '../src/worker/queue.js';
import { fakeRegistry } from './helpers/plugins.js';

async function login(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
}
async function drain(app) {
  await runPending(app.db, {
    blobStore: new BlobStore(app.dataDir),
    derivedStore: new DerivedStore(app.dataDir),
    registry: fakeRegistry(),
  });
}
async function seedVideo(app) {
  const up = await app.upload('/api/files', { filename: 'clip.mp4', contentType: 'video/mp4', body: 'FAKEVIDEO' });
  await drain(app);
  return up.json.file.id;
}
const pub = (app, p, headers = {}) => fetch(app.base + p, { headers });

test('worker pre-generates the HLS bundle and records stream_type', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await login(app);
    const id = await seedVideo(app);
    const row = app.db.prepare('SELECT stream_type, thumbnail_type FROM files WHERE id = ?').get(id);
    assert.equal(row.stream_type, 'hls');
    assert.equal(row.thumbnail_type, 'image/webp');
    // list projects stream_type for a cheap "streamable" affordance.
    const item = (await app.get('/api/files')).json.items.find((i) => i.id === id);
    assert.equal(item.stream_type, 'hls');
  } finally {
    await app.close();
  }
});

test('HTTP: HLS manifest + nested segment served by extension dispatch (no /hls/)', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await login(app);
    const id = await seedVideo(app);

    const master = await app.get(`/api/files/${id}/master.m3u8`);
    assert.equal(master.status, 200);
    assert.equal(master.res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.match(master.text, /#EXT-X-STREAM-INF/);
    assert.match(master.res.headers.get('cache-control'), /immutable/);

    const seg = await app.get(`/api/files/${id}/0/seg_000.ts`);
    assert.equal(seg.status, 200);
    assert.equal(seg.res.headers.get('content-type'), 'video/mp2t');
    assert.equal(seg.text, 'SEGMENT-BYTES');

    // A missing member 404s; a traversal attempt (even with a served ext) is rejected.
    assert.equal((await app.get(`/api/files/${id}/nope.ts`)).status, 404);
    assert.equal((await app.get(`/api/files/${id}/%2e%2e%2fseg_000.ts`)).status, 404);
    // An extension no plugin serves → 404 (never dispatched).
    assert.equal((await app.get(`/api/files/${id}/x.bogus`)).status, 404);
  } finally {
    await app.close();
  }
});

test('public HLS: served when public, 404 when private', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await login(app);
    const id = await seedVideo(app);

    // Private → 404 (no existence leak).
    assert.equal((await pub(app, `/i/${id}/master.m3u8`)).status, 404);

    const col = (await app.post('/api/collections', { name: 'Pub' })).json.collection;
    await app.post(`/api/collections/${col.id}/files`, { fileIds: [id] });
    await app.req('PATCH', `/api/collections/${col.id}`, { body: { visibility: 'public' } });

    const master = await pub(app, `/i/${id}/master.m3u8`);
    assert.equal(master.status, 200);
    assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    const seg = await pub(app, `/i/${id}/0/seg_000.ts`);
    assert.equal(seg.status, 200);
    assert.equal(await seg.text(), 'SEGMENT-BYTES');
  } finally {
    await app.close();
  }
});

test('plugin assets are served, with traversal rejected', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const ok = await app.get('/plugin-assets/video/player.js');
    assert.equal(ok.status, 200);
    assert.match(ok.res.headers.get('content-type'), /javascript/);
    assert.match(ok.text, /fake plugin player/);

    assert.equal((await app.get('/plugin-assets/video/%2e%2e%2f%2e%2e%2fpackage.json')).status, 404);
    assert.equal((await app.get('/plugin-assets/nope/x.js')).status, 404);
  } finally {
    await app.close();
  }
});
