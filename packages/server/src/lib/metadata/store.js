import { coreMetadata } from './core.js';

/**
 * Persist extracted metadata for a version. Extraction is per-version and
 * re-runnable: writing replaces all prior rows for the version, so running it
 * again (e.g. after adding a plugin) is idempotent.
 */

/**
 * @param {object} args
 * @param {number} args.versionId
 * @param {string} args.filename         - original filename, folded into FTS
 * @param {Array<{key:string,value:any,type?:string,source:string}>} args.entries
 * @param {string} [args.fulltext]        - combined extracted text for FTS body
 * @param {string|null} [args.thumbnailType] - content type of the produced
 *        thumbnail, or null for none. Recorded on the version.
 */
export function writeExtraction(db, { versionId, filename, entries, fulltext = '', thumbnailType = null }) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM version_metadata WHERE version_id = ?').run(versionId);
    db.prepare('DELETE FROM metadata_fts WHERE version_id = ?').run(versionId);

    const insert = db.prepare(
      'INSERT INTO version_metadata (version_id, key, value_type, value_text, value_num, source) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const entry of entries) {
      const { value_type, value_text, value_num } = normalizeValue(entry.type, entry.value);
      insert.run(versionId, entry.key, value_type, value_text, value_num, entry.source);
    }

    db.prepare('INSERT INTO metadata_fts (version_id, filename, body) VALUES (?, ?, ?)').run(
      versionId,
      filename ?? '',
      fulltext ?? ''
    );

    db.prepare('UPDATE versions SET thumbnail_type = ? WHERE id = ?').run(thumbnailType, versionId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Write a version's "core" metadata + a filename-only FTS row at creation time,
 * so filename/type/size are searchable immediately — before the background
 * extraction runs. Intended to be called INSIDE the caller's transaction (it
 * manages no transaction of its own). Extraction later overwrites these rows
 * (with the same core values plus plugin metadata + body text).
 */
export function indexVersionCore(db, versionId) {
  const v = db
    .prepare(
      `SELECT v.id, v.byte_size, v.mime_type, v.created_at, a.original_filename AS filename
         FROM versions v JOIN assets a ON a.id = v.asset_id
        WHERE v.id = ?`
    )
    .get(versionId);
  if (!v) return;

  const entries = coreMetadata({
    filename: v.filename,
    mimeType: v.mime_type,
    byteSize: v.byte_size,
    createdAt: v.created_at,
  });

  db.prepare('DELETE FROM version_metadata WHERE version_id = ?').run(versionId);
  db.prepare('DELETE FROM metadata_fts WHERE version_id = ?').run(versionId);

  const insert = db.prepare(
    'INSERT INTO version_metadata (version_id, key, value_type, value_text, value_num, source) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const entry of entries) {
    const { value_type, value_text, value_num } = normalizeValue(entry.type, entry.value);
    insert.run(versionId, entry.key, value_type, value_text, value_num, entry.source);
  }
  db.prepare('INSERT INTO metadata_fts (version_id, filename, body) VALUES (?, ?, ?)').run(
    versionId,
    v.filename ?? '',
    ''
  );
}

/** Read back a version's metadata rows (for API / tests). */
export function getVersionMetadata(db, versionId) {
  return db
    .prepare(
      'SELECT key, value_type, value_text, value_num, source FROM version_metadata WHERE version_id = ? ORDER BY key, id'
    )
    .all(versionId);
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
