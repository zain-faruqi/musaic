/**
 * Read/write operations against the `playlists` table.
 *
 * Membership operations against `playlist_tracks` live in
 * `playlist_tracks.ts`; the two files split the way the two tables
 * do. `getPlaylist` is the exception — it fans across both, but
 * lives here because the call site asks "fetch THIS playlist
 * (header + tracks)" as a single read.
 *
 * Schema lives in migration 0005. The `playlists` row is
 * (id, name, created_at, updated_at); metadata is name-only in v1
 * by design.
 *
 * Validation: `name` is trimmed and required to be 1-256 chars
 * after trim. Empty / whitespace-only / over-length names throw
 * `PlaylistValidationError` carrying a `reason` field — the IPC
 * boundary maps those to the typed discriminated-union output
 * variants on create/rename. Callers that don't care about the
 * reason can `catch (e) { if (e instanceof PlaylistValidationError) … }`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { LibraryTrack } from '../../ipc/channels';
import { trackRowSchema } from './schema';
import { trackRowToUnifiedTrack } from './schema';

/** Max characters allowed in a playlist name (after trim). */
export const PLAYLIST_NAME_MAX_LEN = 256;

export type PlaylistValidationReason = 'empty' | 'too-long';

/**
 * Thrown by `createPlaylist` and `renamePlaylist` when the name
 * fails validation. The IPC layer catches and translates to the
 * `{ kind: 'invalid-name', reason }` discriminated variant.
 *
 * Carries the reason so callers don't have to reparse the message.
 */
export class PlaylistValidationError extends Error {
  readonly reason: PlaylistValidationReason;
  constructor(reason: PlaylistValidationReason) {
    super(`playlist name validation failed: ${reason}`);
    this.name = 'PlaylistValidationError';
    this.reason = reason;
  }
}

/**
 * Internal: validate-and-trim. Returns the trimmed name, throws
 * `PlaylistValidationError` on failure. Centralized so create and
 * rename share the exact same rules.
 */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new PlaylistValidationError('empty');
  }
  if (trimmed.length > PLAYLIST_NAME_MAX_LEN) {
    throw new PlaylistValidationError('too-long');
  }
  return trimmed;
}

/**
 * Playlist header — the shape returned from `createPlaylist` /
 * `renamePlaylist` and embedded in `getPlaylist`'s result.
 */
export type Playlist = {
  readonly id: number;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * Playlist list-row shape — adds `trackCount` for the list view
 * (which renders "N tracks" without needing to fetch each
 * playlist's contents).
 */
export type PlaylistSummary = Playlist & {
  readonly trackCount: number;
};

/**
 * One track in a playlist detail view. Carries the full library
 * row shape (so the UI can render tiles directly) plus the
 * membership-row handle (`playlistTrackId`) and `position`.
 *
 * `playlistTrackId` is the surrogate PK from `playlist_tracks.id`;
 * it's how the renderer addresses a single membership row across
 * remove / reorder operations.
 */
export type PlaylistMembership = {
  readonly playlistTrackId: number;
  readonly position: number;
  readonly track: LibraryTrack;
};

/**
 * Playlist detail view — header + ordered tracks.
 */
export type PlaylistDetail = Playlist & {
  readonly tracks: readonly PlaylistMembership[];
};

/**
 * Insert a new playlist. `created_at` and `updated_at` are both
 * set to `Date.now()` at insert time.
 *
 * @throws PlaylistValidationError on empty / over-length name.
 */
export function createPlaylist(db: DatabaseSync, name: string): Playlist {
  const trimmed = validateName(name);
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO playlists (name, created_at, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(trimmed, now, now);
  // node:sqlite returns lastInsertRowid as a bigint or number
  // depending on size; for an autoincrement INTEGER PK we cast to
  // number — JavaScript safely handles INTEGER PKs up to 2^53.
  const id = Number(result.lastInsertRowid);
  return { id, name: trimmed, createdAt: now, updatedAt: now };
}

/**
 * Rename an existing playlist. Bumps `updated_at` to the current
 * time. Returns the updated row.
 *
 * @throws PlaylistValidationError on empty / over-length name.
 * @throws Error if the playlist doesn't exist (changes === 0).
 */
export function renamePlaylist(
  db: DatabaseSync,
  id: number,
  name: string,
): Playlist {
  const trimmed = validateName(name);
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE playlists
          SET name = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(trimmed, now, id);
  if (result.changes === 0) {
    // Caller treats this as a 404. Distinguishing it from a
    // validation error (which subclasses Error) is up to the
    // caller — IPC translates both, just at different points.
    throw new Error(`playlist not found: ${id}`);
  }
  // Re-fetch to get created_at; cheaper than threading it
  // through and avoids drift if the row's other columns are ever
  // touched here too.
  const row = db
    .prepare('SELECT id, name, created_at, updated_at FROM playlists WHERE id = ?')
    .get(id) as { id: number; name: string; created_at: number; updated_at: number };
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Delete a playlist. Cascades to its `playlist_tracks` rows via
 * the FK ON DELETE CASCADE. Idempotent: deleting a non-existent id
 * returns `false`.
 */
export function deletePlaylist(db: DatabaseSync, id: number): boolean {
  const result = db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Read all playlists with their track counts, ordered most-recently-
 * touched first.
 *
 * LEFT JOIN so playlists with zero tracks still appear (with
 * `trackCount: 0`). The order is by `updated_at DESC` per the
 * locked product decision: rename, create, add-tracks, remove,
 * reorder all bump `updated_at`, so the list reads as "what I
 * worked on lately, top of mind first."
 */
export function listPlaylists(db: DatabaseSync): readonly PlaylistSummary[] {
  const raws = db
    .prepare(
      `SELECT p.id          AS id,
              p.name        AS name,
              p.created_at  AS created_at,
              p.updated_at  AS updated_at,
              COUNT(pt.id)  AS track_count
         FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all() as unknown as ReadonlyArray<{
    id: number;
    name: string;
    created_at: number;
    updated_at: number;
    track_count: number;
  }>;
  return raws.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trackCount: r.track_count,
  }));
}

/**
 * Read a playlist header plus its tracks in position order.
 *
 * Two queries (header, then JOIN against `tracks` ordered by
 * position) rather than one big JOIN. The denormalization at this
 * scale isn't worth it — personal-app playlists are O(hundreds of
 * tracks) at the high end, and two queries on indexed columns are
 * milliseconds.
 *
 * Returns `null` if the playlist id doesn't exist.
 */
export function getPlaylist(
  db: DatabaseSync,
  id: number,
): PlaylistDetail | null {
  const header = db
    .prepare('SELECT id, name, created_at, updated_at FROM playlists WHERE id = ?')
    .get(id) as
    | { id: number; name: string; created_at: number; updated_at: number }
    | undefined;
  if (header === undefined) return null;

  // JOIN to materialize the track rows. ORDER BY position is the
  // dense-int sort the schema's UNIQUE constraint guarantees.
  const rows = db
    .prepare(
      `SELECT pt.id         AS playlist_track_id,
              pt.position   AS position,
              t.source      AS source,
              t.source_id   AS source_id,
              t.path        AS path,
              t.title       AS title,
              t.artists     AS artists,
              t.album       AS album,
              t.duration_ms AS duration_ms,
              t.isrc        AS isrc,
              t.artwork_url AS artwork_url,
              t.mtime       AS mtime,
              t.created_at  AS created_at
         FROM playlist_tracks pt
         JOIN tracks t
           ON t.source = pt.track_source
          AND t.source_id = pt.track_source_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position ASC`,
    )
    .all(id) as unknown as ReadonlyArray<{ playlist_track_id: number; position: number } & Record<string, unknown>>;

  const tracks: PlaylistMembership[] = rows.map((r) => {
    // Parse the track-row half of the join. Reusing trackRowSchema
    // ensures any future column-shape drift is caught here too.
    const trackRow = trackRowSchema.parse({
      source: r.source,
      source_id: r.source_id,
      path: r.path,
      title: r.title,
      artists: r.artists,
      album: r.album,
      duration_ms: r.duration_ms,
      isrc: r.isrc,
      artwork_url: r.artwork_url,
      mtime: r.mtime,
      created_at: r.created_at,
    });
    return {
      playlistTrackId: r.playlist_track_id,
      position: r.position,
      track: trackRowToUnifiedTrack(trackRow),
    };
  });

  return {
    id: header.id,
    name: header.name,
    createdAt: header.created_at,
    updatedAt: header.updated_at,
    tracks,
  };
}
