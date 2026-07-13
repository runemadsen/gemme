import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createAssetWithVersion } from '../src/lib/assets.js';
import {
  createCollection,
  updateCollection,
  deleteCollection,
  listCollections,
  getCollection,
  addAssetToCollection,
  removeAssetFromCollection,
  getAssetCollectionIds,
} from '../src/lib/collections.js';

function seedUser(db) {
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
}
const asset = (db, userId, name) =>
  createAssetWithVersion(db, { filename: name, mimeType: 'text/plain', hash: name, size: 1, userId });

// descendants of a collection (incl. self) via the closure table
const descendants = (db, id) =>
  db.prepare('SELECT descendant FROM collection_closure WHERE ancestor = ? ORDER BY descendant').all(id).map((r) => r.descendant);

test('closure: create builds self + ancestor rows', () => {
  const db = openMemoryDatabase();
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  const c = createCollection(db, { name: 'C', parentId: b.id });

  assert.deepEqual(descendants(db, a.id), [a.id, b.id, c.id]); // A contains B and C
  assert.deepEqual(descendants(db, b.id), [b.id, c.id]);
  assert.deepEqual(descendants(db, c.id), [c.id]);
  // depth is recorded
  assert.equal(db.prepare('SELECT depth FROM collection_closure WHERE ancestor=? AND descendant=?').get(a.id, c.id).depth, 2);
  db.close();
});

test('move: reparenting rebuilds the subtree closure; cycles rejected', () => {
  const db = openMemoryDatabase();
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  const c = createCollection(db, { name: 'C', parentId: b.id });
  const d = createCollection(db, { name: 'D' }); // separate root

  // Move B (with C) under D.
  updateCollection(db, b.id, { parentId: d.id });
  assert.deepEqual(descendants(db, d.id), [b.id, c.id, d.id].sort((x, y) => x - y));
  assert.deepEqual(descendants(db, a.id), [a.id]); // A no longer contains B/C
  assert.deepEqual(descendants(db, b.id), [b.id, c.id]); // subtree intact

  // Cannot move a node into its own subtree.
  assert.throws(() => updateCollection(db, b.id, { parentId: c.id }), /own subtree/);
  assert.throws(() => updateCollection(db, b.id, { parentId: b.id }), /own parent/);
  db.close();
});

test('delete cascades the subtree (assets survive, memberships drop)', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  const x = asset(db, userId, 'x.txt');
  addAssetToCollection(db, x.id, b.id);

  deleteCollection(db, a.id);
  assert.equal(getCollection(db, a.id), null);
  assert.equal(getCollection(db, b.id), null, 'child removed too');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM collection_closure').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM asset_collections').get().c, 0, 'membership gone');
  assert.ok(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(x.id), 'asset survives');
  db.close();
});

test('listCollections returns descendant-inclusive asset counts', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  addAssetToCollection(db, asset(db, userId, '1.txt').id, a.id);
  addAssetToCollection(db, asset(db, userId, '2.txt').id, b.id);

  const byId = Object.fromEntries(listCollections(db).map((c) => [c.id, c.assetCount]));
  assert.equal(byId[a.id], 2, 'A counts its own + B’s assets');
  assert.equal(byId[b.id], 1);
  db.close();
});

test('membership add/remove is idempotent and queryable', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const x = asset(db, userId, 'x.txt');
  addAssetToCollection(db, x.id, a.id);
  addAssetToCollection(db, x.id, a.id); // no error, no dup
  assert.deepEqual(getAssetCollectionIds(db, x.id), [a.id]);
  removeAssetFromCollection(db, x.id, a.id);
  assert.deepEqual(getAssetCollectionIds(db, x.id), []);
  db.close();
});
