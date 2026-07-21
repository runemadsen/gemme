import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createFile, getFile, listFiles, softDeleteFile } from '../src/lib/files.js';
import { searchFiles } from '../src/lib/search/search.js';

function seedUser(db) {
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b.com', 'x')
    .lastInsertRowid;
}

function newFile(db, userId, over = {}) {
  return createFile(db, {
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    hash: 'hash1',
    size: 100,
    userId,
    ...over,
  });
}

test('createFile stores the blob fields and starts pending extraction', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const file = newFile(db, userId);
  assert.equal(file.original_filename, 'photo.jpg');
  assert.equal(file.content_hash, 'hash1');
  assert.equal(file.byte_size, 100);
  assert.equal(file.mime_type, 'image/jpeg');
  assert.equal(file.extraction_status, 'pending');
  db.close();
});

test('core metadata is searchable immediately at upload, before extraction runs', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  // Create the file only — no extraction worker involved.
  createFile(db, { filename: 'DSC01234.jpg', mimeType: 'image/jpeg', hash: 'h', size: 10, userId });

  assert.equal(searchFiles(db, 'DSC').total, 1, 'filename substring found immediately');
  assert.equal(searchFiles(db, 'filename:DSC01234').total, 1);
  assert.equal(searchFiles(db, 'type:image').total, 1, 'type known at upload');
  assert.equal(searchFiles(db, 'nope').total, 0);
  db.close();
});

test('two uploads of same-named file create two distinct files', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  // Same name, different content -> distinct files (a "new version" is a new file).
  const a = newFile(db, userId);
  const b = newFile(db, userId, { hash: 'hash2' });
  assert.notEqual(a.id, b.id);
  assert.equal(listFiles(db).total, 2);
  db.close();
});

test('listFiles excludes soft-deleted and returns blob info', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newFile(db, userId);
  newFile(db, userId, { hash: 'hash2' });
  softDeleteFile(db, a.id);
  const { items, total } = listFiles(db);
  assert.equal(total, 1);
  assert.equal(items[0].byte_size, 100);
  assert.equal(items[0].mime_type, 'image/jpeg');
  assert.equal(getFile(db, a.id), null); // hidden once deleted
  db.close();
});
