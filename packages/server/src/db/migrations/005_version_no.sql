-- Per-asset version number (1, 2, 3…), independent of the global versions.id.
-- The global id stays the internal identity; version_no is the human-facing
-- number shown in the UI.
ALTER TABLE versions ADD COLUMN version_no INTEGER;

-- Backfill existing rows: number each asset's versions by creation (id) order.
UPDATE versions SET version_no = (
  SELECT COUNT(*) FROM versions AS v2
   WHERE v2.asset_id = versions.asset_id AND v2.id <= versions.id
);
