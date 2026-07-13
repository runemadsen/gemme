import { parseQuery, compileQuery } from './dsl.js';
import { normalizeControls } from './compose.js';

// Whitelisted sort fields -> SQL. `date` is upload time; `name` is the filename
// (case-insensitive). Keys are validated, so no injection risk.
const SORT_COLUMNS = {
  date: 'a.created_at',
  name: 'a.original_filename COLLATE NOCASE',
};

/**
 * Search current versions of non-deleted assets with the filter DSL.
 *
 * @returns {{items:object[], total:number, limit:number, offset:number,
 *            sort:string, direction:string, query:string}}
 */
export function searchAssets(db, query = '', { limit = 50, offset = 0, sort = 'date', direction = 'desc' } = {}) {
  const column = SORT_COLUMNS[sort] || SORT_COLUMNS.date;
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
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
        ORDER BY ${column} ${dir}, a.id ${dir}
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

  return { items, total, limit, offset, sort, direction, query };
}

/**
 * Search with page-based pagination + sorting, clamping an out-of-range page to
 * the last page. Shared by GET /api/search and the initial GET / render.
 *
 * @returns {{items, total, page, perPage, pages, sort, direction}}
 */
export function paginatedSearch(db, { query = '', sort, direction, page, perPage } = {}) {
  const c = normalizeControls({ sort, direction, page, perPage });
  const run = (p) =>
    searchAssets(db, query, { limit: c.perPage, offset: (p - 1) * c.perPage, sort: c.sort, direction: c.direction });

  let result = run(c.page);
  const pages = Math.max(1, Math.ceil(result.total / c.perPage));
  let pageNo = c.page;
  if (pageNo > pages) {
    pageNo = pages;
    result = run(pageNo);
  }
  return {
    items: result.items,
    total: result.total,
    page: pageNo,
    perPage: c.perPage,
    pages,
    sort: c.sort,
    direction: c.direction,
  };
}
