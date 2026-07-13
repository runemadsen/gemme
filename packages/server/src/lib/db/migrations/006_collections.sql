-- Collections: nestable groups of assets.
--
-- `parent_id` gives the tree (ON DELETE CASCADE recurses, so deleting a
-- collection removes its whole subtree — assets are untouched, only membership
-- rows go). `collection_closure` holds every ancestor→descendant pair (incl. a
-- self row at depth 0), so "all assets in a collection incl. descendants" is a
-- single indexed join regardless of tree depth.

CREATE TABLE collections (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_collections_parent ON collections(parent_id);
CREATE INDEX idx_collections_name ON collections(name);

-- Many-to-many membership. An asset may belong to any number of collections.
CREATE TABLE asset_collections (
  asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (asset_id, collection_id)
);
CREATE INDEX idx_ac_collection ON asset_collections(collection_id);

CREATE TABLE collection_closure (
  ancestor   INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  descendant INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  depth      INTEGER NOT NULL,
  PRIMARY KEY (ancestor, descendant)
);
CREATE INDEX idx_closure_descendant ON collection_closure(descendant);
