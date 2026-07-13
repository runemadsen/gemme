import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/db/index.js';
import {
  createAssetWithVersion,
  addVersion,
  getAsset,
  listAssets,
  softDeleteAsset,
  deleteVersion,
} from '../src/assets/assets.js';
import { searchAssets } from '../src/search/search.js';

function seedUser(db) {
  return db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('a@b.com', 'x')
    .lastInsertRowid;
}

function newAsset(db, userId, over = {}) {
  return createAssetWithVersion(db, {
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    hash: 'hash1',
    size: 100,
    userId,
    ...over,
  });
}

test('createAssetWithVersion sets the first version as current', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const asset = newAsset(db, userId);
  assert.equal(asset.original_filename, 'photo.jpg');
  assert.equal(asset.versions.length, 1);
  assert.equal(asset.current_version_id, asset.versions[0].id);
  assert.equal(asset.versions[0].is_current, true);
  assert.equal(asset.versions[0].extraction_status, 'pending');
  db.close();
});

test('addVersion makes the newest version current and retains old ones', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newAsset(db, userId);
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
  // Create the asset only — no extraction worker involved.
  createAssetWithVersion(db, { filename: 'DSC01234.jpg', mimeType: 'image/jpeg', hash: 'h', size: 10, userId });

  assert.equal(searchAssets(db, 'DSC').total, 1, 'filename substring found immediately');
  assert.equal(searchAssets(db, 'filename:DSC01234').total, 1);
  assert.equal(searchAssets(db, 'type:image').total, 1, 'type known at upload');
  assert.equal(searchAssets(db, 'nope').total, 0);
  db.close();
});

test('version_no is per-asset, starts at 1, and is independent of global id', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);

  // Create several assets first so global version ids climb past 1.
  const first = newAsset(db, userId);
  newAsset(db, userId);
  const third = newAsset(db, userId, { hash: 'h3' });

  // Each asset's first version is v1 regardless of its global id.
  assert.equal(first.versions[0].version_no, 1);
  assert.equal(third.versions[0].version_no, 1);
  assert.ok(third.versions[0].id > 1, 'global id has advanced past 1');

  // Adding versions increments per-asset.
  const withV2 = addVersion(db, third.id, { hash: 'h3b', size: 2, userId });
  assert.equal(withV2.versions[0].version_no, 2); // newest first
  assert.equal(withV2.versions[1].version_no, 1);
  db.close();
});

test('two uploads of same-named file create two distinct assets', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newAsset(db, userId);
  const b = newAsset(db, userId);
  assert.notEqual(a.id, b.id);
  assert.equal(listAssets(db).total, 2);
  db.close();
});

test('listAssets excludes soft-deleted and returns current-version info', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newAsset(db, userId);
  newAsset(db, userId);
  softDeleteAsset(db, a.id);
  const { items, total } = listAssets(db);
  assert.equal(total, 1);
  assert.equal(items[0].byte_size, 100);
  assert.equal(items[0].mime_type, 'image/jpeg');
  assert.equal(getAsset(db, a.id), null); // hidden once deleted
  db.close();
});

test('deleteVersion promotes newest remaining when deleting current', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newAsset(db, userId);
  const v1 = a.current_version_id;
  const withV2 = addVersion(db, a.id, { hash: 'hash2', size: 2, userId });
  const v2 = withV2.current_version_id;

  const result = deleteVersion(db, a.id, v2); // delete current
  assert.equal(result.newCurrentVersionId, v1);
  const after = getAsset(db, a.id);
  assert.equal(after.current_version_id, v1);
  assert.equal(after.versions.length, 1);
  db.close();
});

test('cannot delete the only version', () => {
  const db = openMemoryDatabase();
  const userId = seedUser(db);
  const a = newAsset(db, userId);
  assert.throws(() => deleteVersion(db, a.id, a.current_version_id), /only version/);
  db.close();
});
