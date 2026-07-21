-- Streaming support. `stream_type` mirrors `thumbnail_type`: it records the
-- kind of pre-generated streaming bundle a plugin produced for the file (e.g.
-- 'hls' for video), or NULL when the file isn't streamable. Set by the worker
-- from a plugin's `serving.pregenerate` return value; surfaced in list/search so
-- the UI can cheaply decide whether to offer a player without touching disk.
ALTER TABLE files ADD COLUMN stream_type TEXT;
