import { parseQuery, compileQuery } from './dsl.js';

/**
 * Search current versions of non-deleted assets with the filter DSL. An empty
 * query returns everything (newest-updated first), so this also backs listing.
 *
 * @returns {{items:object[], total:number, limit:number, offset:number, query:string}}
 */
export function searchAssets(db, query = '', { limit = 50, offset = 0 } = {}) {
  const { conditions, params } = compileQuery(parseQuery(query));
  const where = ['a.deleted_at IS NULL', ...conditions].join(' AND ');

  const items = db
    .prepare(
      `SELECT a.id, a.original_filename, a.created_at, a.updated_at,
              v.id AS current_version_id, v.content_hash, v.byte_size,
              v.mime_type, v.extraction_status, v.thumbnail_type
         FROM assets a
         JOIN versions v ON v.id = a.current_version_id
        WHERE ${where}
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM assets a
         JOIN versions v ON v.id = a.current_version_id
        WHERE ${where}`
    )
    .get(...params).c;

  return { items, total, limit, offset, query };
}
