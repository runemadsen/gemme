-- Core foundational schema: users, assets, versions.
-- Metadata (EAV + FTS), jobs queue, etc. arrive in later migrations.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An asset is a stable identity. Its bytes live in one or more versions;
-- current_version_id points at the newest (set after the version is inserted,
-- hence nullable). Soft-deleted via deleted_at.
CREATE TABLE assets (
  id                 INTEGER PRIMARY KEY,
  original_filename  TEXT NOT NULL,
  current_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at         TEXT
);

-- Immutable content-addressed version. Bytes stored on disk under content_hash.
CREATE TABLE versions (
  id                INTEGER PRIMARY KEY,
  asset_id          INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  content_hash      TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  mime_type         TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  extraction_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX idx_versions_asset ON versions(asset_id);
CREATE INDEX idx_versions_hash ON versions(content_hash);
CREATE INDEX idx_assets_deleted ON assets(deleted_at);
