import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createFile, softDeleteFile } from '../src/lib/files.js';
import { getFacet, getFacets } from '../src/lib/facets.js';
import { searchFiles } from '../src/lib/search/search.js';

function seedUser(db) {
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
}
const add = (db, userId, filename, mimeType) =>
  createFile(db, { filename, mimeType, hash: filename, size: 1, userId });

test('getFacet returns distinct values with counts (whole archive)', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  add(db, userId, 'a.jpg', 'image/jpeg');
  add(db, userId, 'b.jpg', 'image/jpeg');
  add(db, userId, 'c.png', 'image/png');
  add(db, userId, 'notes.txt', 'text/plain');

  const ext = getFacet(db, 'ext');
  assert.deepEqual(
    ext.map((f) => [f.value, f.count]),
    [['jpg', 2], ['png', 1], ['txt', 1]] // ordered by count desc, then value
  );

  const type = getFacet(db, 'type');
  const byType = Object.fromEntries(type.map((f) => [f.value, f.count]));
  assert.equal(byType.image, 3);
  assert.equal(byType.text, 1);
  db.close();
});

test('facets exclude soft-deleted files', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = add(db, userId, 'a.jpg', 'image/jpeg');
  add(db, userId, 'b.png', 'image/png');
  softDeleteFile(db, a.id);

  const ext = getFacet(db, 'ext');
  assert.deepEqual(ext.map((f) => f.value), ['png']);
  db.close();
});

test('getFacets returns multiple keys at once', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  add(db, userId, 'a.jpg', 'image/jpeg');
  const facets = getFacets(db, ['ext', 'type']);
  assert.ok(facets.ext && facets.type);
  db.close();
});

test('selecting facet values filters via ext=jpg,png (OR within facet)', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  add(db, userId, 'a.jpg', 'image/jpeg');
  add(db, userId, 'b.png', 'image/png');
  add(db, userId, 'c.gif', 'image/gif');

  const names = (r) => r.items.map((i) => i.original_filename).sort();
  assert.deepEqual(names(searchFiles(db, 'ext=jpg,png')), ['a.jpg', 'b.png']);
  // combined with another facet (AND across facets)
  assert.deepEqual(names(searchFiles(db, 'ext=jpg,png type=image')), ['a.jpg', 'b.png']);
  db.close();
});
