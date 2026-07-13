import { HttpError } from '../server/respond.js';
import { indexVersionCore } from './metadata/store.js';

/**
 * Data layer for assets and their versions. Enforces the versioning rules:
 * current = newest, new versions are explicit, old versions retained until
 * explicitly deleted.
 *
 * Blob bytes are expected to already be persisted in the BlobStore; these
 * functions only manage the relational records (content_hash, size, etc.).
 */

/**
 * Create a brand-new asset with its first version.
 * @returns {object} the created asset (with versions)
 */
export function createAssetWithVersion(db, { filename, mimeType, hash, size, userId }) {
  db.exec('BEGIN');
  try {
    const asset = db
      .prepare('INSERT INTO assets (original_filename, created_by) VALUES (?, ?)')
      .run(filename, userId ?? null);
    const assetId = asset.lastInsertRowid;
    const versionId = insertVersion(db, { assetId, hash, size, mimeType, userId });
    db.prepare('UPDATE assets SET current_version_id = ? WHERE id = ?').run(versionId, assetId);
    indexVersionCore(db, versionId); // searchable immediately, before extraction
    db.exec('COMMIT');
    return getAsset(db, assetId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Add a new version to an existing asset. The new version becomes current.
 * @returns {object} the updated asset (with versions)
 */
export function addVersion(db, assetId, { mimeType, hash, size, userId }) {
  const asset = db.prepare('SELECT id, deleted_at FROM assets WHERE id = ?').get(assetId);
  if (!asset || asset.deleted_at) throw new HttpError(404, 'Asset not found');

  db.exec('BEGIN');
  try {
    const versionId = insertVersion(db, { assetId, hash, size, mimeType, userId });
    db.prepare(
      "UPDATE assets SET current_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(versionId, assetId);
    indexVersionCore(db, versionId); // searchable immediately, before extraction
    db.exec('COMMIT');
    return getAsset(db, assetId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function insertVersion(db, { assetId, hash, size, mimeType, userId }) {
  // Per-asset version number. MAX+1 (not COUNT+1) so deleting the latest
  // version doesn't hand its number to the next upload.
  const versionNo = db
    .prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM versions WHERE asset_id = ?')
    .get(assetId).n;
  return db
    .prepare(
      'INSERT INTO versions (asset_id, content_hash, byte_size, mime_type, created_by, version_no) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(assetId, hash, size, mimeType ?? null, userId ?? null, versionNo).lastInsertRowid;
}

/** Fetch one asset with all its versions (newest first), or null. */
export function getAsset(db, id, { includeDeleted = false } = {}) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!asset || (!includeDeleted && asset.deleted_at)) return null;
  const versions = db
    .prepare('SELECT * FROM versions WHERE asset_id = ? ORDER BY id DESC')
    .all(id)
    .map((v) => ({ ...v, is_current: v.id === asset.current_version_id }));
  return { ...asset, versions };
}

/** List non-deleted assets, newest-updated first, with current-version info. */
export function listAssets(db, { limit = 50, offset = 0 } = {}) {
  const items = db
    .prepare(
      `SELECT a.id, a.original_filename, a.created_at, a.updated_at,
              v.id AS current_version_id, v.content_hash, v.byte_size,
              v.mime_type, v.extraction_status, v.thumbnail_type
         FROM assets a
         LEFT JOIN versions v ON v.id = a.current_version_id
        WHERE a.deleted_at IS NULL
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM assets WHERE deleted_at IS NULL')
    .get().c;
  return { items, total, limit, offset };
}

/** Soft-delete an asset. Idempotent. */
export function softDeleteAsset(db, id) {
  const info = db
    .prepare(
      "UPDATE assets SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND deleted_at IS NULL"
    )
    .run(id);
  if (info.changes === 0) {
    const exists = db.prepare('SELECT 1 FROM assets WHERE id = ?').get(id);
    if (!exists) throw new HttpError(404, 'Asset not found');
  }
}

/**
 * Delete one version of an asset. Cannot delete the last remaining version
 * (delete the asset instead). Deleting the current version promotes the newest
 * remaining version to current.
 * @returns {{deletedVersionId:number, newCurrentVersionId:number}}
 */
export function deleteVersion(db, assetId, versionId) {
  const asset = db.prepare('SELECT id, current_version_id, deleted_at FROM assets WHERE id = ?').get(assetId);
  if (!asset || asset.deleted_at) throw new HttpError(404, 'Asset not found');

  const version = db.prepare('SELECT id FROM versions WHERE id = ? AND asset_id = ?').get(versionId, assetId);
  if (!version) throw new HttpError(404, 'Version not found');

  const count = db.prepare('SELECT COUNT(*) AS c FROM versions WHERE asset_id = ?').get(assetId).c;
  if (count <= 1) throw new HttpError(409, 'Cannot delete the only version; delete the asset instead');

  db.exec('BEGIN');
  try {
    let newCurrent = asset.current_version_id;
    if (versionId === asset.current_version_id) {
      newCurrent = db
        .prepare('SELECT id FROM versions WHERE asset_id = ? AND id != ? ORDER BY id DESC LIMIT 1')
        .get(assetId, versionId).id;
      db.prepare('UPDATE assets SET current_version_id = ? WHERE id = ?').run(newCurrent, assetId);
    }
    db.prepare('DELETE FROM versions WHERE id = ?').run(versionId);
    db.exec('COMMIT');
    return { deletedVersionId: versionId, newCurrentVersionId: newCurrent };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
