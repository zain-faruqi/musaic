-- Migration 0005: local user-defined playlists.
--
-- Two new tables. `playlists` is the entity; `playlist_tracks` is
-- the join table to `tracks` (composite (source, source_id) FK,
-- matching the post-0002 tracks PK).
--
-- Locked design decisions reflected in this schema:
--
--   * Multi-membership. A track can be in many playlists.
--     `playlist_tracks` is a true join table; no FK column lives
--     on `tracks`.
--   * Manual reorder via an explicit `position` INTEGER column.
--     Order is not derived from timestamps.
--   * Position is a DENSE integer (`0, 1, 2, …`) with renumbering
--     on reorder/remove. Personal-app scale makes O(n) renumber
--     trivially cheap; LexoRank-style fractional indexing is
--     speculative complexity at this scale.
--   * `playlist_tracks.id` is a SURROGATE INTEGER AUTOINCREMENT
--     PK. The `(playlist_id, position)` UNIQUE constraint pins
--     ordering. Surrogate PK matters because (a) reorder UPDATEs
--     by single id (atomic, simple), and (b) the renderer needs a
--     stable handle to address a single membership row — using
--     `(playlist_id, position)` would mean re-issuing handles
--     after every reorder, and using `(playlist_id, source,
--     source_id)` would collide on duplicates within a playlist.
--   * Duplicate tracks are ALLOWED within a playlist. No UNIQUE
--     over (playlist_id, track_source, track_source_id). Matches
--     Spotify; supports "original then remix" sequencing.
--   * Cascade deletes BOTH directions.
--       - `playlists` delete → its `playlist_tracks` rows go.
--       - `tracks` delete → that track's `playlist_tracks` rows
--         go (the watcher's `unlink` on a local file silently
--         removes that file from every playlist it was in).
--     This is the right default for a personal app where the file
--     system is the source of truth; if it becomes friction we
--     revisit.
--
-- FK enforcement. SQLite has foreign keys OFF by default. They are
-- enabled at the connection level by `PRAGMA foreign_keys = ON` in
-- `electron/main/db/index.ts` (openDb). That's a connection
-- pragma, not a schema concern, so it doesn't belong in this file;
-- the playlist_tracks.test.ts covers the end-to-end behavior.
--
-- The `UNIQUE (playlist_id, position)` constraint is the load-
-- bearing piece of the reorder logic. The reorder helper
-- (electron/main/db/playlist_tracks.ts) writes in two phases inside
-- a single transaction: phase 1 moves every row to an offset
-- position (well above any live position), phase 2 writes the final
-- positions. This skirts the constraint mid-transaction; if it
-- weren't done that way SQLite would reject the swap on the first
-- collision.

CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id      INTEGER NOT NULL,
  track_source     TEXT NOT NULL,
  track_source_id  TEXT NOT NULL,
  position         INTEGER NOT NULL,
  added_at         INTEGER NOT NULL,
  FOREIGN KEY (playlist_id)
    REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (track_source, track_source_id)
    REFERENCES tracks(source, source_id) ON DELETE CASCADE,
  UNIQUE (playlist_id, position)
);

-- The detail-view query orders by (playlist_id, position). The
-- listPlaylists count query LEFT JOINs and groups by playlist_id;
-- this index also covers the count's filter side.
CREATE INDEX idx_playlist_tracks_playlist
  ON playlist_tracks (playlist_id, position);

-- The cascade-on-track-delete path: "find every playlist_tracks row
-- whose (track_source, track_source_id) matches the deleted row".
-- Without this index the cascade is a full table scan; with it the
-- lookup is point-indexed.
CREATE INDEX idx_playlist_tracks_track
  ON playlist_tracks (track_source, track_source_id);
