/**
 * Facets power the filter sidebar: for a metadata key, the distinct text values
 * present across the archive with a count of how many files have each. Because
 * metadata is a generic EAV table, this works for any key (ext, type, and later
 * camera_make, orientation, …) with no per-filter backend code.
 *
 * Counts are over the whole archive (current versions of non-deleted files) —
 * i.e. "what's in your library" — not scoped to the active query.
 */

/** @returns {Array<{value:string, count:number}>} */
export function getFacet(db, key, { limit = 500 } = {}) {
  return db
    .prepare(
      `SELECT m.value_text AS value, COUNT(*) AS count
         FROM files a
         JOIN versions v ON v.id = a.current_version_id
         JOIN version_metadata m ON m.version_id = v.id AND m.key = ? AND m.value_type = 'text'
        WHERE a.deleted_at IS NULL
        GROUP BY m.value_text
        ORDER BY count DESC, value ASC
        LIMIT ?`
    )
    .all(key, limit);
}

/** @returns {Record<string, Array<{value:string, count:number}>>} */
export function getFacets(db, keys, opts) {
  const out = {};
  for (const key of keys) out[key] = getFacet(db, key, opts);
  return out;
}
