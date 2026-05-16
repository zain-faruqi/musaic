-- Generalize `tracks` to hold rows from any source.
--
-- Before: local-only. Primary key was `path` (absolute file path).
-- After: (source, source_id) composite PK. `path` is retained but
-- nullable — it's still useful for local rows (musaic-file:// URL
-- construction) but meaningless for youtube and future spotify rows.
--
-- SQLite has no in-place way to change the PK or add NOT NULL columns
-- with defaults that aren't simple constants, so this is a table
-- rewrite: create new, copy from old, drop old, rename. Standard
-- SQLite migration shape; safe inside the runner's per-migration
-- transaction.
--
-- New column `artwork_url` lands here so YouTube rows have a place to
-- store their thumbnail URL. Local rows leave it null in v1; embedded
-- cover-art extraction is a v2 concern.

CREATE TABLE tracks_new (
  source       TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  -- Local-only: the absolute path on disk. Null for non-local rows.
  -- The watcher still uses path for unlink detection (deleteByPath),
  -- which is why we keep the column rather than collapsing it into
  -- source_id for locals alone.
  path         TEXT,
  title        TEXT NOT NULL,
  artists      TEXT NOT NULL,
  album        TEXT,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  isrc         TEXT,
  artwork_url  TEXT,
  mtime        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (source, source_id)
);

-- Carry the existing local rows over. For each row: source='local',
-- source_id=path, path=path, artwork_url=null. mtime / created_at
-- preserved exactly so "Recently Added" ordering survives.
INSERT INTO tracks_new
  (source, source_id, path, title, artists, album, duration_ms, isrc, artwork_url, mtime, created_at)
SELECT
  'local', path, path, title, artists, album, duration_ms, isrc, NULL, mtime, created_at
FROM tracks;

DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;
