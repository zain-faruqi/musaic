-- Initial schema. The local-files index.
--
-- `path` is the natural primary key — it's how we identify files on
-- disk and how the watcher dedups events. created_at is preserved on
-- conflict (see tracks.ts upsertTrack); mtime is updated.
--
-- artists is a JSON-encoded string array.
--
-- No indexes beyond the implicit one on the PK; the home view
-- ("Recently Added", sort by created_at) hasn't landed yet, and we
-- shouldn't speculate on indexes.

CREATE TABLE tracks (
  path        TEXT PRIMARY KEY NOT NULL,
  title       TEXT NOT NULL,
  artists     TEXT NOT NULL,
  album       TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  isrc        TEXT,
  mtime       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
