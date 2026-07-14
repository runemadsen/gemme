import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DerivedStore, extForType } from '../src/lib/storage/derived.js';

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-derived-'));
  return { store: new DerivedStore(dir), dir };
}

test('extForType maps content types to extensions', () => {
  assert.equal(extForType('image/webp'), 'webp');
  assert.equal(extForType('image/jpeg'), 'jpg');
  assert.equal(extForType('application/x-unknown'), 'bin');
});

test('putVariant stores at a sharded, sig+ext path and round-trips', async () => {
  const { store } = await tmpStore();
  const hash = 'abcdef0123456789';
  const sig = 'deadbeefcafef00d';
  assert.equal(store.hasVariant(hash, sig, 'webp'), false);

  await store.putVariant(hash, sig, 'webp', Buffer.from('variant-bytes'));
  assert.equal(store.hasVariant(hash, sig, 'webp'), true);

  const p = store.variantPath(hash, sig, 'webp');
  assert.ok(p.endsWith(path.join('ab', 'cd', `${hash}.${sig}.webp`)));
  assert.ok(fs.existsSync(p));
  assert.ok(store.statVariant(hash, sig, 'webp').size > 0);

  const back = await new Promise((resolve) => {
    const chunks = [];
    store.createVariantReadStream(hash, sig, 'webp').on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });
  assert.equal(back.toString(), 'variant-bytes');
});
