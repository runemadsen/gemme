-- Core foundational schema: users, files.
-- Metadata (EAV + FTS), jobs queue, etc. arrive in later migrations.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A file IS one immutable content-addressed blob. Its bytes are stored on disk
-- under content_hash and never change: re-uploading the same file dedups (see
-- findDuplicateFile), and "a new version of this" is simply a new file. Old
-- versioning (an ordered list of versions with a current pointer) was removed —
-- a file id fully identifies its bytes, which is what makes every serving URL
-- safely immutable-cacheable. Soft-deleted via deleted_at.
CREATE TABLE files (
  id                 INTEGER PRIMARY KEY,
  original_filename  TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  mime_type          TEXT,
  extraction_status  TEXT NOT NULL DEFAULT 'pending',
  -- Derived thumbnail content type (NULL = no thumbnail); keyed by content_hash
  -- in the derived store. Presence powers `has_thumbnail` in list/search.
  thumbnail_type     TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at         TEXT
);

CREATE INDEX idx_files_hash ON files(content_hash);
CREATE INDEX idx_files_deleted ON files(deleted_at);
