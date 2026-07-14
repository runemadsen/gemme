import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { DerivedStore } from '../src/lib/storage/derived.js';
import { parseSpecSegment, specSig, getRendition } from '../src/lib/renditions.js';

test('parseSpecSegment splits params from the extension; cosmetic tokens ignored', () => {
  assert.deepEqual(parseSpecSegment('w=800,fit=cover.webp'), { params: { w: '800', fit: 'cover' }, ext: 'webp' });
  assert.deepEqual(parseSpecSegment('photo.webp'), { params: {}, ext: 'webp' }); // reformat-only
  assert.deepEqual(parseSpecSegment('w=100.jpg'), { params: { w: '100' }, ext: 'jpg' });
  assert.equal(parseSpecSegment('noextension'), null);
});

test('specSig is stable and distinguishes spec + ext', () => {
  assert.equal(specSig({ width: 800 }, 'webp'), specSig({ width: 800 }, 'webp'));
  assert.notEqual(specSig({ width: 800 }, 'webp'), specSig({ width: 800 }, 'jpg'));
  assert.notEqual(specSig({ width: 800 }, 'webp'), specSig({ width: 400 }, 'webp'));
});

async function tmpCtx() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-rend-'));
  const blobStore = new BlobStore(dir);
  const derivedStore = new DerivedStore(dir);
  const { hash } = await blobStore.putBuffer(Buffer.from('source-bytes'));
  return { ctx: { blobStore, derivedStore }, hash, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('getRendition generates once, then serves from the variant cache', async () => {
  const { ctx, hash, cleanup } = await tmpCtx();
  try {
    let runs = 0;
    const renderer = {
      formats: ['webp'],
      async run(source, spec) {
        runs++;
        return { data: Buffer.from(`r:${spec.width}:${spec.format}`), contentType: 'image/webp' };
      },
    };
    const source = { contentHash: hash, mimeType: 'image/png', filename: 'x.png' };

    const a = await getRendition(ctx, source, renderer, { width: 300 }, 'webp');
    assert.equal(a.contentType, 'image/webp');
    assert.equal(ctx.derivedStore.hasVariant(hash, a.sig, 'webp'), true);
    assert.equal(runs, 1);

    const b = await getRendition(ctx, source, renderer, { width: 300 }, 'webp');
    assert.equal(b.sig, a.sig);
    assert.equal(runs, 1, 'second identical request is served from cache (run not called again)');
  } finally {
    await cleanup();
  }
});

test('getRendition throws 415 when the renderer cannot decode', async () => {
  const { ctx, hash, cleanup } = await tmpCtx();
  try {
    const renderer = { formats: ['webp'], async run() { return null; } };
    const source = { contentHash: hash, mimeType: 'application/octet-stream', filename: 'x.raw' };
    await assert.rejects(() => getRendition(ctx, source, renderer, {}, 'webp'), (err) => err.status === 415);
  } finally {
    await cleanup();
  }
});
