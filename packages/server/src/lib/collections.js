import { HttpError } from '../server/respond.js';

/**
 * Collections form an unlimited-depth tree (collections.parent_id) with a
 * closure table maintained alongside so descendant queries stay flat. All
 * mutations run inside the caller-less transactions here.
 */

export function getCollection(db, id) {
  return db.prepare('SELECT id, name, parent_id, created_at, updated_at FROM collections WHERE id = ?').get(id) ?? null;
}

/**
 * List all collections (flat) with a descendant-inclusive count of distinct
 * non-deleted assets. The client builds the tree from parent_id.
 */
export function listCollections(db) {
  const rows = db
    .prepare('SELECT id, name, parent_id, created_at, updated_at FROM collections ORDER BY name COLLATE NOCASE, id')
    .all();
  const counts = new Map(
    db
      .prepare(
        `SELECT cc.ancestor AS id, COUNT(DISTINCT ac.asset_id) AS count
           FROM collection_closure cc
           JOIN asset_collections ac ON ac.collection_id = cc.descendant
           JOIN assets a ON a.id = ac.asset_id AND a.deleted_at IS NULL
          GROUP BY cc.ancestor`
      )
      .all()
      .map((r) => [r.id, r.count])
  );
  return rows.map((r) => ({ ...r, assetCount: counts.get(r.id) || 0 }));
}

/** Create a collection under `parentId` (null = root). Maintains the closure. */
export function createCollection(db, { name, parentId = null, userId = null }) {
  name = String(name ?? '').trim();
  if (!name) throw new HttpError(400, 'Collection name is required');
  if (parentId != null && !getCollection(db, parentId)) throw new HttpError(404, 'Parent collection not found');

  db.exec('BEGIN');
  try {
    const id = db
      .prepare('INSERT INTO collections (name, parent_id, created_by) VALUES (?, ?, ?)')
      .run(name, parentId, userId).lastInsertRowid;

    // Self row, plus a row linking every ancestor of the parent to this node.
    db.prepare('INSERT INTO collection_closure (ancestor, descendant, depth) VALUES (?, ?, 0)').run(id, id);
    if (parentId != null) {
      db.prepare(
        `INSERT INTO collection_closure (ancestor, descendant, depth)
           SELECT ancestor, ?, depth + 1 FROM collection_closure WHERE descendant = ?`
      ).run(id, parentId);
    }
    db.exec('COMMIT');
    return getCollection(db, id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Rename and/or move a collection. Moving rebuilds the subtree's closure. */
export function updateCollection(db, id, { name, parentId } = {}) {
  const current = getCollection(db, id);
  if (!current) throw new HttpError(404, 'Collection not found');

  db.exec('BEGIN');
  try {
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) throw new HttpError(400, 'Collection name is required');
      db.prepare('UPDATE collections SET name = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?').run(trimmed, id);
    }

    if (parentId !== undefined && parentId !== current.parent_id) {
      moveSubtree(db, id, parentId);
    }
    db.exec('COMMIT');
    return getCollection(db, id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function moveSubtree(db, id, newParentId) {
  if (newParentId != null) {
    if (newParentId === id) throw new HttpError(400, 'A collection cannot be its own parent');
    if (!getCollection(db, newParentId)) throw new HttpError(404, 'Parent collection not found');
    // Reject cycles: new parent must not be inside id's subtree.
    const inside = db
      .prepare('SELECT 1 FROM collection_closure WHERE ancestor = ? AND descendant = ?')
      .get(id, newParentId);
    if (inside) throw new HttpError(400, 'Cannot move a collection into its own subtree');
  }

  db.prepare('UPDATE collections SET parent_id = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?').run(newParentId, id);

  // Detach the subtree from its old ancestors (keep internal subtree links).
  db.prepare(
    `DELETE FROM collection_closure
      WHERE descendant IN (SELECT descendant FROM collection_closure WHERE ancestor = ?)
        AND ancestor IN (SELECT ancestor FROM collection_closure WHERE descendant = ? AND ancestor != descendant)`
  ).run(id, id);

  // Re-attach: link every ancestor of the new parent to every node in the subtree.
  if (newParentId != null) {
    db.prepare(
      `INSERT INTO collection_closure (ancestor, descendant, depth)
         SELECT sup.ancestor, sub.descendant, sup.depth + sub.depth + 1
           FROM collection_closure sup
           CROSS JOIN collection_closure sub
          WHERE sup.descendant = ? AND sub.ancestor = ?`
    ).run(newParentId, id);
  }
}

/** Delete a collection and its whole subtree (assets keep, memberships drop). */
export function deleteCollection(db, id) {
  const info = db.prepare('DELETE FROM collections WHERE id = ?').run(id); // cascades subtree + closure + membership
  if (info.changes === 0) throw new HttpError(404, 'Collection not found');
}

// --- membership ------------------------------------------------------------

export function addAssetToCollection(db, assetId, collectionId) {
  if (!getCollection(db, collectionId)) throw new HttpError(404, 'Collection not found');
  if (!db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId))
    throw new HttpError(404, 'Asset not found');
  db.prepare('INSERT OR IGNORE INTO asset_collections (asset_id, collection_id) VALUES (?, ?)').run(assetId, collectionId);
}

export function removeAssetFromCollection(db, assetId, collectionId) {
  db.prepare('DELETE FROM asset_collections WHERE asset_id = ? AND collection_id = ?').run(assetId, collectionId);
}

/** Collection ids an asset belongs to (direct membership). */
export function getAssetCollectionIds(db, assetId) {
  return db
    .prepare('SELECT collection_id FROM asset_collections WHERE asset_id = ? ORDER BY collection_id')
    .all(assetId)
    .map((r) => r.collection_id);
}
