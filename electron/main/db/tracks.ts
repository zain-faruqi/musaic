/**
 * Read/write operations against the `tracks` table.
 *
 * Generalized in 0002 to carry rows from any source (local, youtube,
 * spotify). Primary key is `(source, source_id)`.
 * `path` is local-only and nullable; the watcher's unlink path queries
 * it directly (see `deleteByPath`).
 *
 * Statement preparation is not module-cached because prepared
 * statements are bound to a specific Database instance and we don't
 * carry a global db registry. node:sqlite's internal cache makes
 * re-preparing the same SQL on the same connection cheap.
 */
import type { DatabaseSync } from 'node:sqlite';
import { trackRowSchema, type TrackRow } from './schema';

/**
 * Insert or update a track row, keyed on `(source, source_id)`.
 *
 * On conflict everything except `created_at` is overwritten. Re-importing
 * the same source row (e.g. picking a file already inside the Musaic
 * folder, or pasting the same YouTube URL twice) refreshes the metadata
 * fields from the latest scan/fetch but preserves the original "added
 * at" timestamp — re-import shouldn't bump a track to the top of
 * "Recently Added".
 *
 * Named placeholders use the `:name` prefix (node:sqlite's preferred
 * form). The TrackRow object's keys match the placeholder names
 * exactly, so binding is a direct object-pass.
 */
export function upsertTrack(db: DatabaseSync, row: TrackRow): void {
  db.prepare(
    `INSERT INTO tracks
       (source, source_id, path, title, artists, album,
        duration_ms, isrc, artwork_url, mtime, created_at)
     VALUES
       (:source, :source_id, :path, :title, :artists, :album,
        :duration_ms, :isrc, :artwork_url, :mtime, :created_at)
     ON CONFLICT(source, source_id) DO UPDATE SET
       path = excluded.path,
       title = excluded.title,
       artists = excluded.artists,
       album = excluded.album,
       duration_ms = excluded.duration_ms,
       isrc = excluded.isrc,
       artwork_url = excluded.artwork_url,
       mtime = excluded.mtime`,
  ).run(row);
}

/** Fetch one row by (source, source_id), or undefined if not in the index. */
export function getTrack(
  db: DatabaseSync,
  source: TrackRow['source'],
  sourceId: string,
): TrackRow | undefined {
  const raw = db
    .prepare('SELECT * FROM tracks WHERE source = ? AND source_id = ?')
    .get(source, sourceId);
  if (raw === undefined) return undefined;
  return trackRowSchema.parse(raw);
}

/**
 * Fetch every row, ordered newest-first by `created_at`.
 *
 * Sort lives here, not in renderer code: the `library:list` IPC
 * contract states the result is `ORDER BY created_at DESC`, so this is
 * the function that has to honor it. The renderer would otherwise have
 * to re-sort on every fetch — wasted work, and a place for the sort
 * convention to drift.
 *
 * Returns rows from every source mixed together (local + youtube etc.);
 * the renderer's library view doesn't distinguish.
 */
export function getAllTracks(db: DatabaseSync): readonly TrackRow[] {
  const raws = db
    .prepare('SELECT * FROM tracks ORDER BY created_at DESC')
    .all();
  return raws.map((r) => trackRowSchema.parse(r));
}

/**
 * Remove a row by `(source, source_id)`. Idempotent: deleting a row
 * that isn't in the table is a no-op.
 */
export function deleteTrack(
  db: DatabaseSync,
  source: TrackRow['source'],
  sourceId: string,
): void {
  db.prepare('DELETE FROM tracks WHERE source = ? AND source_id = ?')
    .run(source, sourceId);
}

/**
 * Remove a local row by path. The watcher's `unlink` handler knows the
 * filesystem path, not the (source, source_id) tuple — this is the seam
 * for it.
 *
 * Filtered to `source='local'` because the same string could in theory
 * appear as a `source_id` for another source; without the filter a
 * watcher event on `/foo` would also delete a hypothetical youtube row
 * whose videoId is the string `/foo`. Defensive.
 *
 * Idempotent: deleting a path that isn't in the table is a no-op (the
 * watcher's `unlink` handler may fire for files we never indexed).
 */
export function deleteByPath(db: DatabaseSync, path: string): void {
  db.prepare("DELETE FROM tracks WHERE source = 'local' AND path = ?")
    .run(path);
}
