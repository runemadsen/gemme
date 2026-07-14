import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { createFileWithVersion, findDuplicateFile, softDeleteFile } from '../src/lib/files.js';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

test('findDuplicateFile matches on filename AND current-version hash only', () => {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  createFileWithVersion(db, { filename: 'photo.jpg', mimeType: 'image/jpeg', hash: 'H1', size: 1, userId });

  assert.ok(findDuplicateFile(db, { filename: 'photo.jpg', hash: 'H1' }), 'exact match');
  assert.equal(findDuplicateFile(db, { filename: 'photo.jpg', hash: 'H2' }), null, 'same name, different content');
  assert.equal(findDuplicateFile(db, { filename: 'other.jpg', hash: 'H1' }), null, 'same content, different name');
  db.close();
});

test('findDuplicateFile ignores soft-deleted files', () => {
  const db = openMemoryDatabase();
  const userId = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b', 'x').lastInsertRowid;
  const a = createFileWithVersion(db, { filename: 'x.txt', mimeType: 'text/plain', hash: 'H', size: 1, userId });
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

test('HTTP: adding a byte-identical version is skipped; changed content adds one', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const file = (await app.upload('/api/files', { filename: 'doc.md', contentType: 'text/markdown', body: 'v1' })).json.file;
    assert.equal(file.versions.length, 1);

    // Same bytes as the current version -> skipped, still 1 version.
    const same = await app.upload(`/api/files/${file.id}/versions`, { filename: 'doc.md', contentType: 'text/markdown', body: 'v1' });
    assert.equal(same.status, 200);
    assert.equal(same.json.skipped, true);
    assert.equal((await app.get(`/api/files/${file.id}`)).json.file.versions.length, 1);

    // Different bytes -> a real new version.
    const changed = await app.upload(`/api/files/${file.id}/versions`, { filename: 'doc.md', contentType: 'text/markdown', body: 'v2' });
    assert.equal(changed.status, 201);
    assert.equal(changed.json.skipped, false);
    assert.equal((await app.get(`/api/files/${file.id}`)).json.file.versions.length, 2);
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
