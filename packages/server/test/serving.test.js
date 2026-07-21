import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { DerivedStore } from '../src/lib/storage/derived.js';
import { specSig, servingFor, makeServingApi } from '../src/lib/serving.js';
import { PluginRegistry } from '../src/lib/plugins/registry.js';

test('specSig is stable and distinguishes key + ext', () => {
  assert.equal(specSig({ width: 800 }, 'webp'), specSig({ width: 800 }, 'webp'));
  assert.notEqual(specSig({ width: 800 }, 'webp'), specSig({ width: 800 }, 'jpg'));
  assert.notEqual(specSig({ width: 800 }, 'webp'), specSig({ width: 400 }, 'webp'));
});

test('servingFor picks a matching plugin that serves the extension', () => {
  const img = { id: 'image', matches: (m) => /^image\//.test(m || ''), extract() {}, serving: { formats: ['webp', 'jpg'] } };
  const vid = { id: 'video', matches: (m) => /^video\//.test(m || ''), extract() {}, serving: { formats: ['m3u8', 'ts'] } };
  const reg = new PluginRegistry().register(img).register(vid);
  assert.equal(servingFor(reg, 'image/png', 'a.png', 'webp'), img);
  assert.equal(servingFor(reg, 'video/mp4', 'a.mp4', 'ts'), vid);
  assert.equal(servingFor(reg, 'image/png', 'a.png', 'ts'), null); // image doesn't serve ts
  assert.equal(servingFor(reg, 'text/plain', 'a.txt', 'webp'), null); // no matching plugin
});

async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-serv-'));
  const blobStore = new BlobStore(dir);
  const derivedStore = new DerivedStore(dir);
  const { hash } = await blobStore.putBuffer(Buffer.from('source-bytes'));
  return { ctx: { blobStore, derivedStore }, hash, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const plugin = { id: 'p', serving: { version: 1 } };

test('api.rendition generates once, then serves from the variant cache', async () => {
  const { ctx, hash, cleanup } = await tmp();
  try {
    const api = makeServingApi(ctx, { contentHash: hash, mimeType: 'image/png', filename: 'x.png' }, plugin);
    let runs = 0;
    const produce = async () => {
      runs++;
      return Buffer.from('r:300');
    };
    const d1 = await api.rendition({ width: 300 }, 'webp', 'image/webp', produce);
    assert.equal(d1.contentType, 'image/webp');
    assert.ok(d1.size > 0 && d1.etag && typeof d1.open === 'function');
    const d2 = await api.rendition({ width: 300 }, 'webp', 'image/webp', produce);
    assert.equal(d2.etag, d1.etag);
    assert.equal(runs, 1, 'second identical request served from cache');
  } finally {
    await cleanup();
  }
});

test('api.rendition returns null when the producer yields nothing (→ core 404/415)', async () => {
  const { ctx, hash, cleanup } = await tmp();
  try {
    const api = makeServingApi(ctx, { contentHash: hash }, plugin);
    assert.equal(await api.rendition({}, 'webp', 'image/webp', async () => null), null);
  } finally {
    await cleanup();
  }
});

test('api.buildBundle publishes atomically + idempotently; api.member locates or omits', async () => {
  const { ctx, hash, cleanup } = await tmp();
  try {
    const api = makeServingApi(ctx, { contentHash: hash }, plugin);
    assert.equal(api.member('master.m3u8', 'application/vnd.apple.mpegurl'), null); // not built yet

    let builds = 0;
    const build = () =>
      api.buildBundle(async (outDir) => {
        builds++;
        await fsp.writeFile(path.join(outDir, 'master.m3u8'), 'X');
      });
    await build();
    await build(); // idempotent — no rebuild
    assert.equal(builds, 1);

    const d = api.member('master.m3u8', 'application/vnd.apple.mpegurl');
    assert.ok(d && d.contentType === 'application/vnd.apple.mpegurl' && d.size === 1);
    assert.equal(api.member('../escape', 'text/plain'), null); // traversal rejected
  } finally {
    await cleanup();
  }
});
