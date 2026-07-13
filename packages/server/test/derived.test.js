import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DerivedStore, extForType } from '../src/lib/storage/derived.js';

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-derived-'));
  return { store: new DerivedStore(dir), dir };
}

test('extForType maps content types to extensions', () => {
  assert.equal(extForType('image/webp'), 'webp');
  assert.equal(extForType('image/jpeg'), 'jpg');
  assert.equal(extForType('application/x-unknown'), 'bin');
});

test('putThumb stores at a sharded, type-suffixed path and round-trips', async () => {
  const { store } = await tmpStore();
  const hash = 'abcdef0123456789';
  assert.equal(store.hasThumb(hash, 'image/webp'), false);

  await store.putThumb(hash, 'image/webp', Buffer.from('thumb-bytes'));
  assert.equal(store.hasThumb(hash, 'image/webp'), true);

  const p = store.thumbPath(hash, 'image/webp');
  assert.ok(p.endsWith(path.join('ab', 'cd', `${hash}.thumb.webp`)));
  assert.ok(fs.existsSync(p));

  const back = await new Promise((resolve) => {
    const chunks = [];
    store.createThumbReadStream(hash, 'image/webp').on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });
  assert.equal(back.toString(), 'thumb-bytes');
});
