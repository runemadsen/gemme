-- Per-version thumbnail. The thumbnail is a derived artifact keyed by the
-- version's content_hash in the derived store; here we record only its content
-- type (NULL = no thumbnail). Presence powers `has_thumbnail` in list/search.
ALTER TABLE versions ADD COLUMN thumbnail_type TEXT;
