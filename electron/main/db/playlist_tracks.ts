/**
 * Read/write operations against the `playlist_tracks` table — the
 * join table between playlists and the tracks library.
 *
 * Schema lives in migration 0005. Per-row shape:
 *   id (surrogate PK, AUTOINCREMENT)
 *   playlist_id  -> playlists.id   ON DELETE CASCADE
 *   (track_source, track_source_id)  -> tracks(source, source_id)
 *                                                    ON DELETE CASCADE
 *   position (dense int 0..N-1 within the playlist; UNIQUE per playlist)
 *   added_at
 *
 * Invariants this module preserves:
 *   * After every mutation, `position` is contiguous from 0 within
 *     each playlist (dense-int policy).
 *   * Every mutation touches the parent playlist's `updated_at`.
 *   * `UNIQUE(playlist_id, position)` is never visible in a
 *     half-applied state — reorder uses a two-phase offset write,
 *     remove renumbers in the same transaction as the delete.
 *
 * Concurrency: SQLite serializes writes to a single connection, and
 * the app uses a single shared connection from main. The
 * BEGIN/COMMIT envelopes here are about atomicity (rollback on
 * error) rather than isolation against concurrent writers.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { TrackRow } from './schema';

/**
 * Source enum, reused from the schema's TrackRow shape. Centralizing
 * here means a future widening (a fourth source) propagates from
 * one place rather than copy-pasted enum literals.
 */
export type TrackSource = TrackRow['source'];

/**
 * The offset added to every row's position during phase 1 of
 * reorder. Any value safely above the largest realistic live
 * position works; 1_000_000 is comfortably above any personal-app
 * playlist length (Spotify's own per-playlist cap is 10,000) and
 * well under INTEGER's range. Used by the reorder helper only.
 */
const REORDER_OFFSET = 1_000_000;

/**
 * Input shape for `addTracks`. Just the (source, sourceId) pair —
 * the join is to the `tracks` table, so the renderer references
 * tracks by their library identity.
 */
export type TrackRef = {
  readonly source: TrackSource;
  readonly sourceId: string;
};

export type AddTracksResult = {
  /** Count of input refs that landed as new playlist_tracks rows. */
  readonly added: number;
  /**
   * Count of input refs that were skipped because the referenced
   * track isn't in the `tracks` table. Surfaced as a count rather
   * than per-ref errors because the IPC contract returns this shape
   * to the renderer for inline messaging.
   */
  readonly skipped: number;
};

/**
 * Append tracks to the end of a playlist's ordering. Skips refs
 * whose target row isn't in `tracks` (the FK insert would fail);
 * each successful insert lands at `max(position) + 1` within the
 * playlist, preserving order across the batch.
 *
 * Wraps the inserts AND the parent's `updated_at` bump in a single
 * transaction — if any insert throws (other than the silently
 * caught FK failure), the whole batch rolls back including the
 * timestamp bump.
 */
export function addTracks(
  db: DatabaseSync,
  playlistId: number,
  tracks: readonly TrackRef[],
): AddTracksResult {
  // Verify the playlist exists. Without this an addTracks against
  // a nonexistent playlist would silently no-op (every FK insert
  // would fail on playlist_id → playlists.id). Loud failure is
  // preferable; the IPC layer maps it to a 404-shaped error.
  const playlistExists = db
    .prepare('SELECT 1 FROM playlists WHERE id = ?')
    .get(playlistId);
  if (playlistExists === undefined) {
    throw new Error(`playlist not found: ${playlistId}`);
  }

  let added = 0;
  let skipped = 0;
  const now = Date.now();

  db.exec('BEGIN');
  try {
    // Compute starting position. MAX returns null on an empty
    // playlist; COALESCE-as-(-1) means the first insert lands at 0.
    let nextPosition =
      (
        db
          .prepare(
            'SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?',
          )
          .get(playlistId) as { m: number }
      ).m + 1;

    const insertStmt = db.prepare(
      `INSERT INTO playlist_tracks
        (playlist_id, track_source, track_source_id, position, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const ref of tracks) {
      try {
        insertStmt.run(playlistId, ref.source, ref.sourceId, nextPosition, now);
        added += 1;
        nextPosition += 1;
      } catch (err) {
        // The only expected failure here is the FK violation for
        // a (source, source_id) not in the `tracks` table. Other
        // errors (disk full, syntax, etc.) should not be swallowed.
        // node:sqlite throws a generic Error with the SQLite error
        // string in `.message`; we match on the FK-failed text
        // rather than an error code (node:sqlite doesn't expose
        // SQLITE_CONSTRAINT_FOREIGNKEY as a discrete property).
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('FOREIGN KEY constraint failed')) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }

    // Bump the parent's updated_at. Same now used for added_at
    // so the surfaced "added" and "touched" times agree.
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(
      now,
      playlistId,
    );

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Implicit rollback path; nothing to do.
    }
    throw err;
  }

  return { added, skipped };
}

/**
 * Delete a subset of memberships from a playlist (by their
 * surrogate `playlist_track_id`), then renumber the remaining
 * positions to close any gaps so the dense-int invariant holds.
 *
 * Scopes the DELETE to `playlist_id` defensively: an id from a
 * different playlist won't be removed even if it happens to land
 * in the input. The renderer is supposed to address only its own
 * playlist's ids, but the boundary check costs nothing.
 *
 * Returns the count actually removed. A zero count for a non-empty
 * input doesn't throw — it just means none of the ids matched
 * within this playlist (the caller asked for stale rows; idempotent).
 *
 * Wrapped in a transaction so the delete + renumber land together.
 */
export function removeTracks(
  db: DatabaseSync,
  playlistId: number,
  playlistTrackIds: readonly number[],
): { readonly removed: number } {
  // Empty input is a no-op; skip the round-trip and the touch.
  if (playlistTrackIds.length === 0) return { removed: 0 };

  // Verify the playlist exists — same rationale as addTracks.
  const playlistExists = db
    .prepare('SELECT 1 FROM playlists WHERE id = ?')
    .get(playlistId);
  if (playlistExists === undefined) {
    throw new Error(`playlist not found: ${playlistId}`);
  }

  const now = Date.now();
  let removed = 0;

  db.exec('BEGIN');
  try {
    // Build a parameter list for the IN clause. node:sqlite has no
    // built-in array binding; the placeholder string is constructed
    // from the input length.
    const placeholders = playlistTrackIds.map(() => '?').join(',');
    const deleteResult = db
      .prepare(
        `DELETE FROM playlist_tracks
          WHERE playlist_id = ?
            AND id IN (${placeholders})`,
      )
      .run(playlistId, ...playlistTrackIds);
    removed = Number(deleteResult.changes);

    // Renumber. Read the surviving rows in their current position
    // order, then assign positions 0..N-1 by id. Two-phase write
    // (same as reorder) to dodge the UNIQUE(playlist_id, position)
    // constraint during the rewrite — even when the renumber is
    // monotonic, an UPDATE that sets row A's position to row B's
    // current value would briefly collide.
    const rows = db
      .prepare(
        `SELECT id FROM playlist_tracks
          WHERE playlist_id = ?
          ORDER BY position ASC`,
      )
      .all(playlistId) as unknown as ReadonlyArray<{ id: number }>;
    const offsetStmt = db.prepare(
      `UPDATE playlist_tracks SET position = position + ${REORDER_OFFSET}
        WHERE playlist_id = ?`,
    );
    offsetStmt.run(playlistId);
    const finalStmt = db.prepare(
      'UPDATE playlist_tracks SET position = ? WHERE id = ?',
    );
    rows.forEach((r, i) => {
      finalStmt.run(i, r.id);
    });

    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(
      now,
      playlistId,
    );

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Implicit rollback path; nothing to do.
    }
    throw err;
  }

  return { removed };
}

/**
 * Reorder all memberships within a playlist to match the given
 * ordered list of `playlist_track_id`s.
 *
 * Validation: the input length must match the current count, and
 * the set must match exactly (no missing or extra ids). Validation
 * runs BEFORE any mutation so a bad input doesn't half-apply.
 *
 * The two-phase update is the trick that lets us swap positions
 * without violating `UNIQUE(playlist_id, position)` mid-transaction:
 *
 *   Phase 1: UPDATE every row in this playlist so that
 *            position += REORDER_OFFSET. The new positions are far
 *            above any live position, so no collision.
 *   Phase 2: For each id in the input array, UPDATE its position
 *            to its index. Each UPDATE moves one row from "high
 *            offset land" to its final position; since input ids
 *            are distinct and we're writing 0..N-1, no two phase-2
 *            writes collide either.
 *
 * Both phases plus the parent's `updated_at` bump live in one
 * transaction. A throw anywhere rolls everything back.
 */
export function reorderTracks(
  db: DatabaseSync,
  playlistId: number,
  orderedPlaylistTrackIds: readonly number[],
): void {
  // Verify the playlist exists.
  const playlistExists = db
    .prepare('SELECT 1 FROM playlists WHERE id = ?')
    .get(playlistId);
  if (playlistExists === undefined) {
    throw new Error(`playlist not found: ${playlistId}`);
  }

  // Snapshot current ids before any mutation. We need both the
  // count and the set for validation.
  const existingRows = db
    .prepare(
      'SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC',
    )
    .all(playlistId) as unknown as ReadonlyArray<{ id: number }>;
  const existing = new Set(existingRows.map((r) => r.id));

  if (orderedPlaylistTrackIds.length !== existing.size) {
    throw new Error(
      `reorderTracks: input length ${orderedPlaylistTrackIds.length} does not match playlist size ${existing.size}`,
    );
  }
  const incoming = new Set(orderedPlaylistTrackIds);
  if (incoming.size !== orderedPlaylistTrackIds.length) {
    throw new Error('reorderTracks: input contains duplicate ids');
  }
  // Same-size + no-dup-in-input means set equality is sufficient.
  for (const id of incoming) {
    if (!existing.has(id)) {
      throw new Error(
        `reorderTracks: id ${id} is not a member of playlist ${playlistId}`,
      );
    }
  }

  const now = Date.now();

  db.exec('BEGIN');
  try {
    // Phase 1: move every row out of the live position range.
    db.prepare(
      `UPDATE playlist_tracks
          SET position = position + ${REORDER_OFFSET}
        WHERE playlist_id = ?`,
    ).run(playlistId);

    // Phase 2: write final positions.
    const setPositionStmt = db.prepare(
      'UPDATE playlist_tracks SET position = ? WHERE id = ?',
    );
    orderedPlaylistTrackIds.forEach((id, i) => {
      setPositionStmt.run(i, id);
    });

    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(
      now,
      playlistId,
    );

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Implicit rollback path; nothing to do.
    }
    throw err;
  }
}
