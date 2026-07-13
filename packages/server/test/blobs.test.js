import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BlobStore } from '../src/storage/blobs.js';

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-blobs-'));
  return { store: new BlobStore(dir), dir };
}

// sha256("hello world") is well-known
const HELLO_HASH = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

test('putBuffer returns the sha256 hash and stores at a sharded path', async () => {
  const { store } = await tmpStore();
  const res = await store.putBuffer(Buffer.from('hello world'));
  assert.equal(res.hash, HELLO_HASH);
  assert.equal(res.size, 11);
  assert.equal(res.deduped, false);

  const expected = path.join('b9', '4d', HELLO_HASH);
  assert.ok(store.pathForHash(HELLO_HASH).endsWith(expected));
  assert.ok(fs.existsSync(store.pathForHash(HELLO_HASH)));
});

test('identical content dedups on second put', async () => {
  const { store } = await tmpStore();
  const first = await store.putBuffer(Buffer.from('dup'));
  const second = await store.putBuffer(Buffer.from('dup'));
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(first.hash, second.hash);
});

test('readBuffer round-trips the stored bytes', async () => {
  const { store } = await tmpStore();
  const { hash } = await store.putBuffer(Buffer.from('round trip'));
  const out = await store.readBuffer(hash);
  assert.equal(out.toString(), 'round trip');
});

test('putStream hashes on the fly and matches putBuffer', async () => {
  const { store } = await tmpStore();
  const res = await store.putStream(Readable.from([Buffer.from('hello '), Buffer.from('world')]));
  assert.equal(res.hash, HELLO_HASH);
  assert.equal(res.size, 11);
  assert.ok(store.has(HELLO_HASH));
});

test('putStream dedups and leaves no temp files behind', async () => {
  const { store, dir } = await tmpStore();
  await store.putStream(Readable.from([Buffer.from('abc')]));
  const second = await store.putStream(Readable.from([Buffer.from('abc')]));
  assert.equal(second.deduped, true);
  const leftovers = fs
    .readdirSync(path.join(dir, 'blobs'))
    .filter((f) => f.startsWith('.tmp-'));
  assert.deepEqual(leftovers, []);
});
