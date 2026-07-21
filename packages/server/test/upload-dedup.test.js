import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createFile, findDuplicateFile, softDeleteFile } from '../src/lib/files.js';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

test('findDuplicateFile matches on filename AND content hash only', () => {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  createFile(db, { filename: 'photo.jpg', mimeType: 'image/jpeg', hash: 'H1', size: 1, userId });

  assert.ok(findDuplicateFile(db, { filename: 'photo.jpg', hash: 'H1' }), 'exact match');
  assert.equal(findDuplicateFile(db, { filename: 'photo.jpg', hash: 'H2' }), null, 'same name, different content');
  assert.equal(findDuplicateFile(db, { filename: 'other.jpg', hash: 'H1' }), null, 'same content, different name');
  db.close();
});

test('findDuplicateFile ignores soft-deleted files', () => {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  const a = createFile(db, { filename: 'x.txt', mimeType: 'text/plain', hash: 'H', size: 1, userId });
  softDeleteFile(db, a.id);
  assert.equal(findDuplicateFile(db, { filename: 'x.txt', hash: 'H' }), null);
  db.close();
});

test('HTTP: re-uploading the same file+name is skipped; variations still import', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const first = await app.upload('/api/files', { filename: 'a.txt', contentType: 'text/plain', body: 'hello' });
    assert.equal(first.status, 201);
    assert.equal(first.json.skipped, false);

    // Exact same name + content -> skipped, no new file.
    const dup = await app.upload('/api/files', { filename: 'a.txt', contentType: 'text/plain', body: 'hello' });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.skipped, true);
    assert.equal(dup.json.file.id, first.json.file.id);
    assert.equal((await app.get('/api/files')).json.total, 1);

    // Same name, different content -> new file.
    assert.equal((await app.upload('/api/files', { filename: 'a.txt', contentType: 'text/plain', body: 'changed' })).json.skipped, false);
    // Different name, same content -> new file (blob dedups, file does not).
    assert.equal((await app.upload('/api/files', { filename: 'b.txt', contentType: 'text/plain', body: 'hello' })).json.skipped, false);
    assert.equal((await app.get('/api/files')).json.total, 3);
  } finally {
    await app.close();
  }
});

test('HTTP: uploading 10 where 5 exist imports only the remaining 5', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    // Seed 5 files.
    for (let i = 0; i < 5; i++)
      await app.upload('/api/files', { filename: `f${i}.txt`, contentType: 'text/plain', body: `content ${i}` });
    assert.equal((await app.get('/api/files')).json.total, 5);

    // Now upload 10: the original 5 (identical) + 5 new ones.
    let created = 0;
    let skipped = 0;
    for (let i = 0; i < 10; i++) {
      const r = await app.upload('/api/files', { filename: `f${i}.txt`, contentType: 'text/plain', body: `content ${i}` });
      if (r.json.skipped) skipped++;
      else created++;
    }
    assert.equal(skipped, 5, '5 duplicates skipped');
    assert.equal(created, 5, '5 new imported');
    assert.equal((await app.get('/api/files')).json.total, 10);
  } finally {
    await app.close();
  }
});
