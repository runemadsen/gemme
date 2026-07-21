import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { PluginRegistry } from '../src/lib/plugins/registry.js';
import { runExtraction, runPending } from '../src/worker/index.js';
import { enqueueExtraction, pendingJobCount } from '../src/worker/queue.js';
import { getFileMetadata } from '../src/lib/metadata/store.js';
import { fakeRegistry } from './helpers/plugins.js';

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-worker-'));
  const db = openMemoryDatabase();
  const blobStore = new BlobStore(dir);
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x')
    .lastInsertRowid;
  async function seedFile({ filename, mimeType, buffer }) {
    const { hash, size } = await blobStore.putBuffer(buffer);
    const file = db
      .prepare('INSERT INTO files (original_filename, content_hash, byte_size, mime_type, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(filename, hash, size, mimeType, userId);
    return file.lastInsertRowid;
  }
  return { db, blobStore, dir, seedFile, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const meta = (rows, key) => rows.filter((r) => r.key === key);

test('extraction records core metadata for any file', async () => {
  const s = await setup();
  try {
    const vid = await s.seedFile({ filename: 'a.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('xyz') });
    await runExtraction(s.db, { blobStore: s.blobStore, registry: new PluginRegistry() }, vid);
    const rows = getFileMetadata(s.db, vid);
    assert.equal(meta(rows, 'type')[0].value_text, 'other');
    assert.equal(meta(rows, 'size')[0].value_num, 3);
    assert.equal(meta(rows, 'ext')[0].value_text, 'bin');
    assert.ok(rows.every((r) => r.source === 'core'));
  } finally {
    await s.cleanup();
  }
});

test('text plugin adds counts and full text is searchable', async () => {
  const s = await setup();
  try {
    const vid = await s.seedFile({ filename: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('mountain sky\ntree river') });
    await runExtraction(s.db, { blobStore: s.blobStore, registry: fakeRegistry() }, vid);
    const rows = getFileMetadata(s.db, vid);
    assert.equal(meta(rows, 'type')[0].value_text, 'text');
    assert.equal(meta(rows, 'word_count')[0].value_num, 4);
    assert.equal(meta(rows, 'char_count').length, 1);

    // FTS finds a word from the body
    const hit = s.db
      .prepare('SELECT file_id FROM metadata_fts WHERE metadata_fts MATCH ?')
      .get('mountain');
    assert.equal(hit.file_id, vid);
  } finally {
    await s.cleanup();
  }
});

test('image plugin extracts width/height (source tagged)', async () => {
  const s = await setup();
  try {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(1920, 16);
    buf.writeUInt32BE(1080, 20);
    const vid = await s.seedFile({ filename: 'p.png', mimeType: 'image/png', buffer: buf });
    await runExtraction(s.db, { blobStore: s.blobStore, registry: fakeRegistry() }, vid);
    const rows = getFileMetadata(s.db, vid);
    assert.equal(meta(rows, 'width')[0].value_num, 1920);
    assert.equal(meta(rows, 'width')[0].source, 'image');
    assert.equal(meta(rows, 'orientation')[0].value_text, 'landscape');
  } finally {
    await s.cleanup();
  }
});

test('multiple plugins merge; a failing plugin is isolated', async () => {
  const s = await setup();
  try {
    const boom = { id: 'boom', matches: () => true, extract: () => { throw new Error('kaboom'); } };
    const tagger = {
      id: 'tagger',
      matches: () => true,
      extract: async () => ({ metadata: [{ key: 'label', value: 'mountain', type: 'text' }, { key: 'label', value: 'sky', type: 'text' }] }),
    };
    const registry = new PluginRegistry().register(boom).register(tagger);

    const vid = await s.seedFile({ filename: 'p.png', mimeType: 'image/png', buffer: Buffer.from('data') });
    const result = await runExtraction(s.db, { blobStore: s.blobStore, registry }, vid);

    // tagger's multi-valued output survived; boom was isolated
    const rows = getFileMetadata(s.db, vid);
    assert.equal(meta(rows, 'label').length, 2, 'both label values stored');
    assert.deepEqual(result.pluginErrors.map((e) => e.plugin), ['boom']);
  } finally {
    await s.cleanup();
  }
});

test('re-running extraction is idempotent (no duplicate rows)', async () => {
  const s = await setup();
  try {
    const vid = await s.seedFile({ filename: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    const ctx = { blobStore: s.blobStore, registry: fakeRegistry() };
    await runExtraction(s.db, ctx, vid);
    const firstCount = getFileMetadata(s.db, vid).length;
    await runExtraction(s.db, ctx, vid);
    assert.equal(getFileMetadata(s.db, vid).length, firstCount);
    // FTS also deduped to one row
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM metadata_fts WHERE file_id = ?').get(vid).c, 1);
  } finally {
    await s.cleanup();
  }
});

test('queue: enqueue dedups and runPending drains + sets status', async () => {
  const s = await setup();
  try {
    const vid = await s.seedFile({ filename: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi there') });
    enqueueExtraction(s.db, vid);
    enqueueExtraction(s.db, vid); // dedup — still one pending
    assert.equal(pendingJobCount(s.db), 1);

    const processed = await runPending(s.db, { blobStore: s.blobStore, registry: fakeRegistry() });
    assert.equal(processed, 1);
    assert.equal(pendingJobCount(s.db), 0);

    const status = s.db.prepare('SELECT extraction_status FROM files WHERE id = ?').get(vid).extraction_status;
    assert.equal(status, 'done');
  } finally {
    await s.cleanup();
  }
});
