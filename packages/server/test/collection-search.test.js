import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createFile } from '../src/lib/files.js';
import { createCollection, addFileToCollection } from '../src/lib/collections.js';
import { searchFiles } from '../src/lib/search/search.js';
import { parseQueryString } from '../src/lib/search/compose.js';

function setup() {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  const file = (name, mimeType = 'text/plain') =>
    createFile(db, { filename: name, mimeType, hash: name, size: 1, userId });
  return { db, file };
}
const names = (db, q) => searchFiles(db, q).items.map((i) => i.original_filename).sort();

test('collection is recognized as a filter key in the query string', () => {
  assert.deepEqual(parseQueryString('collection=Trips'), { text: '', filters: { collection: ['Trips'] } });
  assert.deepEqual(parseQueryString('mountains collection=Trips,Photos').filters, {
    collection: ['Trips', 'Photos'],
  });
});

test('collection filter is descendant-inclusive (by name)', () => {
  const { db, file } = setup();
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  addFileToCollection(db, file('in-a.txt').id, a.id);
  addFileToCollection(db, file('in-b.txt').id, b.id);
  file('loose.txt'); // in no collection

  // A includes B's files; B is just B.
  assert.deepEqual(names(db, 'collection=A'), ['in-a.txt', 'in-b.txt']);
  assert.deepEqual(names(db, 'collection=B'), ['in-b.txt']);
  db.close();
});

test('duplicate collection names union their subtrees', () => {
  const { db, file } = setup();
  const p1 = createCollection(db, { name: 'Parent1' });
  const p2 = createCollection(db, { name: 'Parent2' });
  const dupA = createCollection(db, { name: 'Dup', parentId: p1.id });
  const dupB = createCollection(db, { name: 'Dup', parentId: p2.id });
  addFileToCollection(db, file('a.txt').id, dupA.id);
  addFileToCollection(db, file('b.txt').id, dupB.id);

  // Selecting the name "Dup" shows files from BOTH same-named collections.
  assert.deepEqual(names(db, 'collection=Dup'), ['a.txt', 'b.txt']);
  db.close();
});

test('multi-select ORs collection names; combines (AND) with other filters', () => {
  const { db, file } = setup();
  const trips = createCollection(db, { name: 'Trips' });
  const docs = createCollection(db, { name: 'Docs' });
  const img = file('photo.jpg', 'image/jpeg'); // image
  const txt = file('note.txt'); // text
  addFileToCollection(db, img.id, trips.id);
  addFileToCollection(db, txt.id, docs.id);

  assert.deepEqual(names(db, 'collection=Trips,Docs'), ['note.txt', 'photo.jpg']);
  // AND with a facet: only the image in Trips
  assert.deepEqual(names(db, 'collection=Trips,Docs type=image'), ['photo.jpg']);
  db.close();
});

test('negated collection excludes its files', () => {
  const { db, file } = setup();
  const a = createCollection(db, { name: 'A' });
  addFileToCollection(db, file('in.txt').id, a.id);
  file('out.txt');
  assert.deepEqual(names(db, '-collection=A'), ['out.txt']);
  db.close();
});
