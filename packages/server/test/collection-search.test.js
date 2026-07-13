import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createAssetWithVersion } from '../src/lib/assets.js';
import { createCollection, addAssetToCollection } from '../src/lib/collections.js';
import { searchAssets } from '../src/lib/search/search.js';
import { parseQueryString } from '../src/lib/search/compose.js';

function setup() {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  const asset = (name, mimeType = 'text/plain') =>
    createAssetWithVersion(db, { filename: name, mimeType, hash: name, size: 1, userId });
  return { db, asset };
}
const names = (db, q) => searchAssets(db, q).items.map((i) => i.original_filename).sort();

test('collection is recognized as a filter key in the query string', () => {
  assert.deepEqual(parseQueryString('collection=Trips'), { text: '', filters: { collection: ['Trips'] } });
  assert.deepEqual(parseQueryString('mountains collection=Trips,Photos').filters, {
    collection: ['Trips', 'Photos'],
  });
});

test('collection filter is descendant-inclusive (by name)', () => {
  const { db, asset } = setup();
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  addAssetToCollection(db, asset('in-a.txt').id, a.id);
  addAssetToCollection(db, asset('in-b.txt').id, b.id);
  asset('loose.txt'); // in no collection

  // A includes B's assets; B is just B.
  assert.deepEqual(names(db, 'collection=A'), ['in-a.txt', 'in-b.txt']);
  assert.deepEqual(names(db, 'collection=B'), ['in-b.txt']);
  db.close();
});

test('duplicate collection names union their subtrees', () => {
  const { db, asset } = setup();
  const p1 = createCollection(db, { name: 'Parent1' });
  const p2 = createCollection(db, { name: 'Parent2' });
  const dupA = createCollection(db, { name: 'Dup', parentId: p1.id });
  const dupB = createCollection(db, { name: 'Dup', parentId: p2.id });
  addAssetToCollection(db, asset('a.txt').id, dupA.id);
  addAssetToCollection(db, asset('b.txt').id, dupB.id);

  // Selecting the name "Dup" shows assets from BOTH same-named collections.
  assert.deepEqual(names(db, 'collection=Dup'), ['a.txt', 'b.txt']);
  db.close();
});

test('multi-select ORs collection names; combines (AND) with other filters', () => {
  const { db, asset } = setup();
  const trips = createCollection(db, { name: 'Trips' });
  const docs = createCollection(db, { name: 'Docs' });
  const img = asset('photo.jpg', 'image/jpeg'); // image
  const txt = asset('note.txt'); // text
  addAssetToCollection(db, img.id, trips.id);
  addAssetToCollection(db, txt.id, docs.id);

  assert.deepEqual(names(db, 'collection=Trips,Docs'), ['note.txt', 'photo.jpg']);
  // AND with a facet: only the image in Trips
  assert.deepEqual(names(db, 'collection=Trips,Docs type=image'), ['photo.jpg']);
  db.close();
});

test('negated collection excludes its assets', () => {
  const { db, asset } = setup();
  const a = createCollection(db, { name: 'A' });
  addAssetToCollection(db, asset('in.txt').id, a.id);
  asset('out.txt');
  assert.deepEqual(names(db, '-collection=A'), ['out.txt']);
  db.close();
});
