import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { migrate } from '../src/lib/db/migrate.js';

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

test('migration creates the core tables', () => {
  const db = openMemoryDatabase(); // migrates on open
  const tables = tableNames(db);
  for (const t of ['users', 'files', 'versions', 'schema_migrations']) {
    assert.ok(tables.includes(t), `expected table ${t}`);
  }
  db.close();
});

test('migrate is idempotent — a second run applies nothing', () => {
  const db = openMemoryDatabase({ migrate: false });
  const first = migrate(db);
  assert.ok(first.length >= 1, 'first run applies migrations');
  const second = migrate(db);
  assert.deepEqual(second, [], 'second run applies nothing');
  db.close();
});

test('applied migrations are recorded in schema_migrations', () => {
  const db = openMemoryDatabase();
  const rows = db.prepare('SELECT name FROM schema_migrations').all();
  assert.ok(rows.some((r) => r.name === '001_core.sql'));
  db.close();
});

test('foreign keys are enforced', () => {
  const db = openMemoryDatabase();
  // versions.file_id references a non-existent file -> should fail
  assert.throws(() => {
    db.prepare(
      'INSERT INTO versions (file_id, content_hash, byte_size) VALUES (?, ?, ?)'
    ).run(999, 'deadbeef', 10);
  }, /FOREIGN KEY/i);
  db.close();
});
