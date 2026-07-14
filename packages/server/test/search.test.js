import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { fakeRegistry } from './helpers/plugins.js';
import { runExtraction } from '../src/worker/index.js';
import { searchFiles, paginatedSearch } from '../src/lib/search/search.js';
import { createFileWithVersion } from '../src/lib/files.js';

function pngBuf(w, h) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-search-'));
  const db = openMemoryDatabase();
  const blobStore = new BlobStore(dir);
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x')
    .lastInsertRowid;
  const ctx = { blobStore, registry: fakeRegistry() };

  async function add({ filename, mimeType, buffer }) {
    const { hash, size } = await blobStore.putBuffer(buffer);
    db.exec('BEGIN');
    const file = db.prepare('INSERT INTO files (original_filename, created_by) VALUES (?, ?)').run(filename, userId);
    const version = db
      .prepare('INSERT INTO versions (file_id, content_hash, byte_size, mime_type) VALUES (?, ?, ?, ?)')
      .run(file.lastInsertRowid, hash, size, mimeType);
    db.prepare('UPDATE files SET current_version_id = ? WHERE id = ?').run(version.lastInsertRowid, file.lastInsertRowid);
    db.exec('COMMIT');
    await runExtraction(db, ctx, version.lastInsertRowid);
    return file.lastInsertRowid;
  }

  return { db, add, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const names = (r) => r.items.map((i) => i.original_filename).sort();

test('DSL search over real extracted metadata', async () => {
  const s = await setup();
  try {
    await s.add({ filename: 'trip.md', mimeType: 'text/markdown', buffer: Buffer.from('mountain sky river') });
    await s.add({ filename: 'beach.txt', mimeType: 'text/plain', buffer: Buffer.from('beach sunset waves') });
    await s.add({ filename: 'wide.png', mimeType: 'image/png', buffer: pngBuf(1920, 1080) });
    await s.add({ filename: 'tall.png', mimeType: 'image/png', buffer: pngBuf(480, 640) });

    // empty query returns everything
    assert.equal(searchFiles(s.db, '').total, 4);

    // field equality on core metadata
    assert.deepEqual(names(searchFiles(s.db, 'type:image')), ['tall.png', 'wide.png']);
    assert.deepEqual(names(searchFiles(s.db, 'type:text')), ['beach.txt', 'trip.md']);

    // numeric comparison from the image plugin
    assert.deepEqual(names(searchFiles(s.db, 'width>1000')), ['wide.png']);
    assert.deepEqual(names(searchFiles(s.db, 'type:image height>1000')), ['wide.png']);
    assert.deepEqual(names(searchFiles(s.db, 'type:image width<1000')), ['tall.png']);

    // text value from plugin
    assert.deepEqual(names(searchFiles(s.db, 'orientation:portrait')), ['tall.png']);

    // full-text (single + AND of two terms)
    assert.deepEqual(names(searchFiles(s.db, 'mountain')), ['trip.md']);
    assert.deepEqual(names(searchFiles(s.db, 'sky river')), ['trip.md']);
    assert.equal(searchFiles(s.db, 'sky beach').total, 0);

    // negation
    assert.deepEqual(names(searchFiles(s.db, '-type:image')), ['beach.txt', 'trip.md']);
    assert.deepEqual(names(searchFiles(s.db, 'type:image -orientation:portrait')), ['wide.png']);

    // filename contains
    assert.deepEqual(names(searchFiles(s.db, 'filename:trip')), ['trip.md']);

    // combined: free text + field
    assert.deepEqual(names(searchFiles(s.db, 'sunset type:text')), ['beach.txt']);
  } finally {
    await s.cleanup();
  }
});

test('free-text matches filename substrings, case-insensitively (e.g. DSC)', async () => {
  const s = await setup();
  try {
    // Camera-style names: FTS tokenizes "DSC01234.jpg" to the single token
    // "dsc01234", so a bare "DSC" only matches via the filename substring path.
    await s.add({ filename: 'DSC01234.jpg', mimeType: 'image/jpeg', buffer: pngBuf(4000, 3000) });
    await s.add({ filename: 'DSC09999.JPG', mimeType: 'image/jpeg', buffer: pngBuf(3000, 4000) });
    await s.add({ filename: 'beach-photo.png', mimeType: 'image/png', buffer: pngBuf(800, 600) });

    assert.deepEqual(names(searchFiles(s.db, 'DSC')), ['DSC01234.jpg', 'DSC09999.JPG']);
    assert.deepEqual(names(searchFiles(s.db, 'dsc')), ['DSC01234.jpg', 'DSC09999.JPG']); // case-insensitive
    assert.deepEqual(names(searchFiles(s.db, 'beach')), ['beach-photo.png']);
    // combined with a field clause
    assert.deepEqual(names(searchFiles(s.db, 'DSC type:image')), ['DSC01234.jpg', 'DSC09999.JPG']);
    // negation excludes the matches
    assert.deepEqual(names(searchFiles(s.db, '-DSC')), ['beach-photo.png']);
  } finally {
    await s.cleanup();
  }
});

test('searchFiles sorts by name and date, asc and desc', () => {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  // Insert in a deliberately non-alphabetical, non-chronological-friendly order.
  const mk = (name) => createFileWithVersion(db, { filename: name, mimeType: 'text/plain', hash: name, size: 1, userId });
  mk('banana.txt');
  mk('apple.txt');
  mk('cherry.txt');

  const names = (opts) => searchFiles(db, '', opts).items.map((i) => i.original_filename);
  assert.deepEqual(names({ sort: 'name', direction: 'asc' }), ['apple.txt', 'banana.txt', 'cherry.txt']);
  assert.deepEqual(names({ sort: 'name', direction: 'desc' }), ['cherry.txt', 'banana.txt', 'apple.txt']);
  // date desc = newest first (insertion order reversed); asc = oldest first
  assert.deepEqual(names({ sort: 'date', direction: 'asc' }), ['banana.txt', 'apple.txt', 'cherry.txt']);
  assert.deepEqual(names({ sort: 'date', direction: 'desc' }), ['cherry.txt', 'apple.txt', 'banana.txt']);
  db.close();
});

test('paginatedSearch returns page slices + meta and clamps overshoot', () => {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  for (let i = 1; i <= 5; i++)
    createFileWithVersion(db, { filename: `f${i}.txt`, mimeType: 'text/plain', hash: `h${i}`, size: 1, userId });

  const p1 = paginatedSearch(db, { sort: 'name', direction: 'asc', page: 1, perPage: 2 });
  assert.deepEqual(p1.items.map((i) => i.original_filename), ['f1.txt', 'f2.txt']);
  assert.equal(p1.total, 5);
  assert.equal(p1.pages, 3);
  assert.equal(p1.page, 1);

  const p3 = paginatedSearch(db, { sort: 'name', direction: 'asc', page: 3, perPage: 2 });
  assert.deepEqual(p3.items.map((i) => i.original_filename), ['f5.txt']);

  // Page beyond range clamps to the last page.
  const over = paginatedSearch(db, { sort: 'name', direction: 'asc', page: 99, perPage: 2 });
  assert.equal(over.page, 3);
  assert.deepEqual(over.items.map((i) => i.original_filename), ['f5.txt']);
  db.close();
});

test('pagination reports total independent of limit', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++)
      await s.add({ filename: `n${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`file ${i}`) });
    const page = searchFiles(s.db, '', { limit: 2, offset: 0 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 5);
  } finally {
    await s.cleanup();
  }
});
