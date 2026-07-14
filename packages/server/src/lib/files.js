import { HttpError } from '../server/respond.js';
import { indexVersionCore } from './metadata/store.js';

/**
 * Data layer for files and their versions. Enforces the versioning rules:
 * current = newest, new versions are explicit, old versions retained until
 * explicitly deleted.
 *
 * Blob bytes are expected to already be persisted in the BlobStore; these
 * functions only manage the relational records (content_hash, size, etc.).
 */

/**
 * Create a brand-new file with its first version.
 * @returns {object} the created file (with versions)
 */
export function createFileWithVersion(db, { filename, mimeType, hash, size, userId }) {
  db.exec('BEGIN');
  try {
    const file = db
      .prepare('INSERT INTO files (original_filename, created_by) VALUES (?, ?)')
      .run(filename, userId ?? null);
    const fileId = file.lastInsertRowid;
    const versionId = insertVersion(db, { fileId, hash, size, mimeType, userId });
    db.prepare('UPDATE files SET current_version_id = ? WHERE id = ?').run(versionId, fileId);
    indexVersionCore(db, versionId); // searchable immediately, before extraction
    db.exec('COMMIT');
    return getFile(db, fileId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Add a new version to an existing file. The new version becomes current.
 * @returns {object} the updated file (with versions)
 */
export function addVersion(db, fileId, { mimeType, hash, size, userId }) {
  const file = db.prepare('SELECT id, deleted_at FROM files WHERE id = ?').get(fileId);
  if (!file || file.deleted_at) throw new HttpError(404, 'File not found');

  db.exec('BEGIN');
  try {
    const versionId = insertVersion(db, { fileId, hash, size, mimeType, userId });
    db.prepare(
      "UPDATE files SET current_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(versionId, fileId);
    indexVersionCore(db, versionId); // searchable immediately, before extraction
    db.exec('COMMIT');
    return getFile(db, fileId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function insertVersion(db, { fileId, hash, size, mimeType, userId }) {
  // Per-file version number. MAX+1 (not COUNT+1) so deleting the latest
  // version doesn't hand its number to the next upload.
  const versionNo = db
    .prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM versions WHERE file_id = ?')
    .get(fileId).n;
  return db
    .prepare(
      'INSERT INTO versions (file_id, content_hash, byte_size, mime_type, created_by, version_no) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(fileId, hash, size, mimeType ?? null, userId ?? null, versionNo).lastInsertRowid;
}

/** Fetch one file with all its versions (newest first), or null. */
export function getFile(db, id, { includeDeleted = false } = {}) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file || (!includeDeleted && file.deleted_at)) return null;
  const versions = db
    .prepare('SELECT * FROM versions WHERE file_id = ? ORDER BY id DESC')
    .all(id)
    .map((v) => ({ ...v, is_current: v.id === file.current_version_id }));
  return { ...file, versions };
}

/**
 * Find an existing non-deleted file that is the *exact same file*: same
 * original filename AND whose current version has the same content hash. Used
 * to skip re-importing a duplicate on upload. Returns the file or null.
 */
export function findDuplicateFile(db, { filename, hash }) {
  const row = db
    .prepare(
      `SELECT a.id
         FROM files a
         JOIN versions v ON v.id = a.current_version_id
        WHERE a.deleted_at IS NULL AND a.original_filename = ? AND v.content_hash = ?
        LIMIT 1`
    )
    .get(filename, hash);
  return row ? getFile(db, row.id) : null;
}

/** List non-deleted files, newest-updated first, with current-version info. */
export function listFiles(db, { limit = 50, offset = 0 } = {}) {
  const items = db
    .prepare(
      `SELECT a.id, a.original_filename, a.created_at, a.updated_at,
              v.id AS current_version_id, v.content_hash, v.byte_size,
              v.mime_type, v.extraction_status, v.thumbnail_type
         FROM files a
         LEFT JOIN versions v ON v.id = a.current_version_id
        WHERE a.deleted_at IS NULL
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NULL')
    .get().c;
  return { items, total, limit, offset };
}

/** Soft-delete an file. Idempotent. */
export function softDeleteFile(db, id) {
  const info = db
    .prepare(
      "UPDATE files SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND deleted_at IS NULL"
    )
    .run(id);
  if (info.changes === 0) {
    const exists = db.prepare('SELECT 1 FROM files WHERE id = ?').get(id);
    if (!exists) throw new HttpError(404, 'File not found');
  }
}

/**
 * Delete one version of an file. Cannot delete the last remaining version
 * (delete the file instead). Deleting the current version promotes the newest
 * remaining version to current.
 * @returns {{deletedVersionId:number, newCurrentVersionId:number}}
 */
export function deleteVersion(db, fileId, versionId) {
  const file = db.prepare('SELECT id, current_version_id, deleted_at FROM files WHERE id = ?').get(fileId);
  if (!file || file.deleted_at) throw new HttpError(404, 'File not found');

  const version = db.prepare('SELECT id FROM versions WHERE id = ? AND file_id = ?').get(versionId, fileId);
  if (!version) throw new HttpError(404, 'Version not found');

  const count = db.prepare('SELECT COUNT(*) AS c FROM versions WHERE file_id = ?').get(fileId).c;
  if (count <= 1) throw new HttpError(409, 'Cannot delete the only version; delete the file instead');

  db.exec('BEGIN');
  try {
    let newCurrent = file.current_version_id;
    if (versionId === file.current_version_id) {
      newCurrent = db
        .prepare('SELECT id FROM versions WHERE file_id = ? AND id != ? ORDER BY id DESC LIMIT 1')
        .get(fileId, versionId).id;
      db.prepare('UPDATE files SET current_version_id = ? WHERE id = ?').run(newCurrent, fileId);
    }
    db.prepare('DELETE FROM versions WHERE id = ?').run(versionId);
    db.exec('COMMIT');
    return { deletedVersionId: versionId, newCurrentVersionId: newCurrent };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
