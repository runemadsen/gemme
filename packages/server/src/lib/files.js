import { HttpError } from '../server/respond.js';
import { indexFileCore } from './metadata/store.js';

/**
 * Data layer for files. A file IS one immutable content-addressed blob: its
 * bytes never change. Re-uploading the exact same file dedups (see
 * findDuplicateFile); "a new version of this" is simply a new file. There is no
 * version history.
 *
 * Blob bytes are expected to already be persisted in the BlobStore; these
 * functions only manage the relational records (content_hash, size, etc.).
 */

/**
 * Create a file from an uploaded blob. Indexes its core metadata synchronously
 * so it's searchable immediately, before background extraction runs.
 * @returns {object} the created file
 */
export function createFile(db, { filename, mimeType, hash, size, userId }) {
  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        'INSERT INTO files (original_filename, content_hash, byte_size, mime_type, created_by) VALUES (?, ?, ?, ?, ?)'
      )
      .run(filename, hash, size, mimeType ?? null, userId ?? null);
    const fileId = info.lastInsertRowid;
    indexFileCore(db, fileId); // searchable immediately, before extraction
    db.exec('COMMIT');
    return getFile(db, fileId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Fetch one file, or null. */
export function getFile(db, id, { includeDeleted = false } = {}) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file || (!includeDeleted && file.deleted_at)) return null;
  return file;
}

/**
 * Find an existing non-deleted file that is the *exact same file*: same
 * original filename AND same content hash. Used to skip re-importing a duplicate
 * on upload. Returns the file or null.
 */
export function findDuplicateFile(db, { filename, hash }) {
  const row = db
    .prepare(
      'SELECT id FROM files WHERE deleted_at IS NULL AND original_filename = ? AND content_hash = ? LIMIT 1'
    )
    .get(filename, hash);
  return row ? getFile(db, row.id) : null;
}

/** List non-deleted files, newest-updated first. */
export function listFiles(db, { limit = 50, offset = 0 } = {}) {
  const items = db
    .prepare(
      `SELECT id, original_filename, created_at, updated_at,
              content_hash, byte_size, mime_type, extraction_status, thumbnail_type, stream_type
         FROM files
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NULL')
    .get().c;
  return { items, total, limit, offset };
}

/** Soft-delete a file. Idempotent. */
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

/** Soft-delete many files in one transaction. Any missing id aborts the batch. */
export function softDeleteFiles(db, ids) {
  db.exec('BEGIN');
  try {
    for (const id of ids) softDeleteFile(db, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
