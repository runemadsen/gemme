import { coreMetadata } from './core.js';

/**
 * Persist extracted metadata for a file. Extraction is per-file and
 * re-runnable: writing replaces all prior rows for the file, so running it
 * again (e.g. after adding a plugin) is idempotent.
 */

/**
 * @param {object} args
 * @param {number} args.fileId
 * @param {string} args.filename         - original filename, folded into FTS
 * @param {Array<{key:string,value:any,type?:string,source:string}>} args.entries
 * @param {string} [args.fulltext]        - combined extracted text for FTS body
 * @param {string|null} [args.thumbnailType] - content type of the produced
 *        thumbnail, or null for none. Recorded on the file.
 * @param {string|null} [args.streamType]  - kind of streaming bundle produced
 *        (e.g. 'hls'), or null for none. Recorded on the file.
 */
export function writeExtraction(
  db,
  { fileId, filename, entries, fulltext = '', thumbnailType = null, streamType = null }
) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM file_metadata WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM metadata_fts WHERE file_id = ?').run(fileId);

    const insert = db.prepare(
      'INSERT INTO file_metadata (file_id, key, value_type, value_text, value_num, source) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const entry of entries) {
      const { value_type, value_text, value_num } = normalizeValue(entry.type, entry.value);
      insert.run(fileId, entry.key, value_type, value_text, value_num, entry.source);
    }

    db.prepare('INSERT INTO metadata_fts (file_id, filename, body) VALUES (?, ?, ?)').run(
      fileId,
      filename ?? '',
      fulltext ?? ''
    );

    db.prepare('UPDATE files SET thumbnail_type = ?, stream_type = ? WHERE id = ?').run(
      thumbnailType,
      streamType,
      fileId
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Write a file's "core" metadata + a filename-only FTS row at creation time,
 * so filename/type/size are searchable immediately — before the background
 * extraction runs. Intended to be called INSIDE the caller's transaction (it
 * manages no transaction of its own). Extraction later overwrites these rows
 * (with the same core values plus plugin metadata + body text).
 */
export function indexFileCore(db, fileId) {
  const f = db
    .prepare(
      `SELECT id, byte_size, mime_type, created_at, original_filename AS filename
         FROM files WHERE id = ?`
    )
    .get(fileId);
  if (!f) return;

  const entries = coreMetadata({
    filename: f.filename,
    mimeType: f.mime_type,
    byteSize: f.byte_size,
    createdAt: f.created_at,
  });

  db.prepare('DELETE FROM file_metadata WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM metadata_fts WHERE file_id = ?').run(fileId);

  const insert = db.prepare(
    'INSERT INTO file_metadata (file_id, key, value_type, value_text, value_num, source) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const entry of entries) {
    const { value_type, value_text, value_num } = normalizeValue(entry.type, entry.value);
    insert.run(fileId, entry.key, value_type, value_text, value_num, entry.source);
  }
  db.prepare('INSERT INTO metadata_fts (file_id, filename, body) VALUES (?, ?, ?)').run(
    fileId,
    f.filename ?? '',
    ''
  );
}

/** Read back a file's metadata rows (for API / tests). */
export function getFileMetadata(db, fileId) {
  return db
    .prepare(
      'SELECT key, value_type, value_text, value_num, source FROM file_metadata WHERE file_id = ? ORDER BY key, id'
    )
    .all(fileId);
}

/**
 * Coerce a plugin-declared value into the typed columns. `date` accepts a
 * Date, epoch ms, or ISO string; stored as epoch ms in value_num + ISO text.
 */
export function normalizeValue(type, value) {
  switch (type) {
    case 'number': {
      const n = Number(value);
      return { value_type: 'number', value_text: String(value), value_num: Number.isFinite(n) ? n : null };
    }
    case 'bool':
      return { value_type: 'bool', value_text: value ? 'true' : 'false', value_num: value ? 1 : 0 };
    case 'date': {
      const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
      const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
      return { value_type: 'date', value_text: iso, value_num: Number.isFinite(ms) ? ms : null };
    }
    case 'text':
    default:
      return { value_type: 'text', value_text: String(value), value_num: null };
  }
}
