import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import {
  createFileWithVersion,
  addVersion,
  getFile,
  listFiles,
  softDeleteFile,
  deleteVersion,
} from '../src/lib/files.js';
import { searchFiles } from '../src/lib/search/search.js';

function seedUser(db) {
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b.com', 'x')
    .lastInsertRowid;
}

function newFile(db, userId, over = {}) {
  return createFileWithVersion(db, {
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    hash: 'hash1',
    size: 100,
    userId,
    ...over,
  });
}

test('createFileWithVersion sets the first version as current', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const file = newFile(db, userId);
  assert.equal(file.original_filename, 'photo.jpg');
  assert.equal(file.versions.length, 1);
  assert.equal(file.current_version_id, file.versions[0].id);
  assert.equal(file.versions[0].is_current, true);
  assert.equal(file.versions[0].extraction_status, 'pending');
  db.close();
});

test('addVersion makes the newest version current and retains old ones', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newFile(db, userId);
  const v1 = a.current_version_id;
  const updated = addVersion(db, a.id, { mimeType: 'image/jpeg', hash: 'hash2', size: 200, userId });
  assert.equal(updated.versions.length, 2);
  assert.notEqual(updated.current_version_id, v1);
  // newest (highest id) is current
  assert.equal(updated.current_version_id, updated.versions[0].id);
  // old version retained
  assert.ok(updated.versions.some((v) => v.id === v1 && !v.is_current));
  db.close();
});

test('core metadata is searchable immediately at upload, before extraction runs', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  // Create the file only — no extraction worker involved.
  createFileWithVersion(db, { filename: 'DSC01234.jpg', mimeType: 'image/jpeg', hash: 'h', size: 10, userId });

  assert.equal(searchFiles(db, 'DSC').total, 1, 'filename substring found immediately');
  assert.equal(searchFiles(db, 'filename:DSC01234').total, 1);
  assert.equal(searchFiles(db, 'type:image').total, 1, 'type known at upload');
  assert.equal(searchFiles(db, 'nope').total, 0);
  db.close();
});

test('version_no is per-file, starts at 1, and is independent of global id', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);

  // Create several files first so global version ids climb past 1.
  const first = newFile(db, userId);
  newFile(db, userId);
  const third = newFile(db, userId, { hash: 'h3' });

  // Each file's first version is v1 regardless of its global id.
  assert.equal(first.versions[0].version_no, 1);
  assert.equal(third.versions[0].version_no, 1);
  assert.ok(third.versions[0].id > 1, 'global id has advanced past 1');

  // Adding versions increments per-file.
  const withV2 = addVersion(db, third.id, { hash: 'h3b', size: 2, userId });
  assert.equal(withV2.versions[0].version_no, 2); // newest first
  assert.equal(withV2.versions[1].version_no, 1);
  db.close();
});

test('two uploads of same-named file create two distinct files', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newFile(db, userId);
  const b = newFile(db, userId);
  assert.notEqual(a.id, b.id);
  assert.equal(listFiles(db).total, 2);
  db.close();
});

test('listFiles excludes soft-deleted and returns current-version info', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newFile(db, userId);
  newFile(db, userId);
  softDeleteFile(db, a.id);
  const { items, total } = listFiles(db);
  assert.equal(total, 1);
  assert.equal(items[0].byte_size, 100);
  assert.equal(items[0].mime_type, 'image/jpeg');
  assert.equal(getFile(db, a.id), null); // hidden once deleted
  db.close();
});

test('deleteVersion promotes newest remaining when deleting current', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newFile(db, userId);
  const v1 = a.current_version_id;
  const withV2 = addVersion(db, a.id, { hash: 'hash2', size: 2, userId });
  const v2 = withV2.current_version_id;

  const result = deleteVersion(db, a.id, v2); // delete current
  assert.equal(result.newCurrentVersionId, v1);
  const after = getFile(db, a.id);
  assert.equal(after.current_version_id, v1);
  assert.equal(after.versions.length, 1);
  db.close();
});

test('cannot delete the only version', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newFile(db, userId);
  assert.throws(() => deleteVersion(db, a.id, a.current_version_id), /only version/);
  db.close();
});
