import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createFileWithVersion } from '../src/lib/files.js';
import {
  createCollection,
  updateCollection,
  deleteCollection,
  listCollections,
  getCollection,
  addFileToCollection,
  removeFileFromCollection,
  addFilesToCollection,
  removeFilesFromCollection,
  getFileCollectionIds,
  isFilePublic,
} from '../src/lib/collections.js';

function seedUser(db) {
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
}
const file = (db, userId, name) =>
  createFileWithVersion(db, { filename: name, mimeType: 'text/plain', hash: name, size: 1, userId });

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

test('delete cascades the subtree (files survive, memberships drop)', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  const x = file(db, userId, 'x.txt');
  addFileToCollection(db, x.id, b.id);

  deleteCollection(db, a.id);
  assert.equal(getCollection(db, a.id), null);
  assert.equal(getCollection(db, b.id), null, 'child removed too');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM collection_closure').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM file_collections').get().c, 0, 'membership gone');
  assert.ok(db.prepare('SELECT 1 FROM files WHERE id = ?').get(x.id), 'file survives');
  db.close();
});

test('listCollections returns descendant-inclusive file counts', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  addFileToCollection(db, file(db, userId, '1.txt').id, a.id);
  addFileToCollection(db, file(db, userId, '2.txt').id, b.id);

  const byId = Object.fromEntries(listCollections(db).map((c) => [c.id, c.fileCount]));
  assert.equal(byId[a.id], 2, 'A counts its own + B’s files');
  assert.equal(byId[b.id], 1);
  db.close();
});

test('membership add/remove is idempotent and queryable', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const x = file(db, userId, 'x.txt');
  addFileToCollection(db, x.id, a.id);
  addFileToCollection(db, x.id, a.id); // no error, no dup
  assert.deepEqual(getFileCollectionIds(db, x.id), [a.id]);
  removeFileFromCollection(db, x.id, a.id);
  assert.deepEqual(getFileCollectionIds(db, x.id), []);
  db.close();
});

test('visibility: isFilePublic true via direct or ancestor public; validated', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const b = createCollection(db, { name: 'B', parentId: a.id });
  const other = createCollection(db, { name: 'Other' });
  const inB = file(db, userId, 'inB.txt');
  const inOther = file(db, userId, 'o.txt');
  addFileToCollection(db, inB.id, b.id);
  addFileToCollection(db, inOther.id, other.id);

  assert.equal(isFilePublic(db, inB.id), false, 'private by default');

  // Making the ANCESTOR public cascades to files in the child collection.
  assert.equal(updateCollection(db, a.id, { visibility: 'public' }).visibility, 'public');
  assert.equal(isFilePublic(db, inB.id), true);
  assert.equal(isFilePublic(db, inOther.id), false, 'unrelated private collection stays private');

  // Direct membership in a public collection.
  const inA = file(db, userId, 'a.txt');
  addFileToCollection(db, inA.id, a.id);
  assert.equal(isFilePublic(db, inA.id), true);

  assert.throws(() => updateCollection(db, a.id, { visibility: 'bogus' }), /visibility/);
  db.close();
});

test('bulk membership: add/remove many files atomically', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = createCollection(db, { name: 'A' });
  const ids = ['1.txt', '2.txt', '3.txt'].map((n) => file(db, userId, n).id);

  addFilesToCollection(db, a.id, ids);
  addFilesToCollection(db, a.id, [ids[0]]); // idempotent, no dup
  for (const id of ids) assert.deepEqual(getFileCollectionIds(db, id), [a.id]);

  removeFilesFromCollection(db, a.id, [ids[0], ids[1]]);
  assert.deepEqual(getFileCollectionIds(db, ids[0]), []);
  assert.deepEqual(getFileCollectionIds(db, ids[2]), [a.id]);

  // Unknown collection throws; a missing file aborts the whole batch (rollback).
  assert.throws(() => addFilesToCollection(db, 9999, ids), /Collection not found/);
  // ids[0] is currently NOT a member; batching it with a bad id must roll back its add.
  assert.throws(() => addFilesToCollection(db, a.id, [ids[0], 9999]), /File not found/);
  assert.deepEqual(getFileCollectionIds(db, ids[0]), [], 'no partial write from aborted batch');
  db.close();
});
