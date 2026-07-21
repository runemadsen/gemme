-- Extracted metadata (typed EAV — the substrate the search DSL queries),
-- full-text index, and the durable background job queue.

-- One row per (file, key) contribution. Keys are NOT unique per file:
-- a plugin may emit many values for one key (e.g. object labels), and multiple
-- plugins may contribute the same key (disambiguated by `source`).
CREATE TABLE file_metadata (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_type TEXT NOT NULL,              -- text | number | date | bool
  value_text TEXT,                       -- display / string comparisons
  value_num  REAL,                       -- numeric / date(epoch ms) / bool(0|1)
  source     TEXT NOT NULL               -- plugin id (or 'core')
);

CREATE INDEX idx_fm_file ON file_metadata(file_id);
CREATE INDEX idx_fm_key_num ON file_metadata(key, value_num);
CREATE INDEX idx_fm_key_text ON file_metadata(key, value_text);

-- Full-text index over filename + extracted text, keyed to a file.
CREATE VIRTUAL TABLE metadata_fts USING fts5(filename, body, file_id UNINDEXED);

-- Durable background queue. Survives restarts; re-runnable.
CREATE TABLE jobs (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_file ON jobs(file_id);
