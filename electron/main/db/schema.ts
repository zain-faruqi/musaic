/**
 * Type definitions for SQLite rows and conversions to/from the
 * over-the-wire track shape.
 *
 * `LibraryTrack` (the conversion target) is imported from
 * electron/ipc/channels — a peer module on the main side, not from
 * src/core. Main-process code can't reach into src/ because the two
 * are bundled by separate tsconfigs (see electron/main/index.ts's
 * comment about the boundary).
 *
 * Schema generalization: `tracks` carries rows from any source.
 * `source` discriminates ('local' | 'youtube' | 'spotify');
 * `source_id` is the per-source identifier (file path for local,
 * videoId for youtube, canonical Spotify URI `spotify:track:<id>`
 * for spotify — the URI form, not the bare 22-char trackId; the
 * adapter sends `{ uris: [sourceId] }` to PUT /me/player/play which
 * requires the URI form. See migration 0004's header comment for
 * the background). `path` is retained as a separate column
 * (nullable, local-only) so the watcher's `unlink` handler can
 * still query by path.
 * spotify-admit migration 0003).
 *
 * Why Zod here too: the SQLite driver returns `unknown`-typed rows. We
 * could cast, but a parse step costs almost nothing and catches
 * schema drift if a future migration changes a column's type without
 * updating these.
 */
import { z } from 'zod';
import type { LibraryTrack } from '../../ipc/channels';

export const trackRowSchema = z.object({
  source: z.enum(['local', 'youtube', 'spotify']),
  source_id: z.string(),
  /** Local rows only; null for youtube and spotify rows. */
  path: z.string().nullable(),
  title: z.string(),
  /** JSON array of strings. Parse with `artistsJsonSchema`. */
  artists: z.string(),
  album: z.string().nullable(),
  duration_ms: z.number().int().nonnegative(),
  isrc: z.string().nullable(),
  /** Remote URL (e.g. YouTube thumbnail). Null until artwork is known. */
  artwork_url: z.string().nullable(),
  mtime: z.number().nonnegative(),
  created_at: z.number().nonnegative(),
});
export type TrackRow = z.infer<typeof trackRowSchema>;

export const artistsJsonSchema = z.array(z.string());

/**
 * Convert a stored row to the over-the-wire track shape.
 *
 * The id format `<source>:<source_id>` is stable across sessions —
 * the same file (or videoId) produces the same id whether it arrived
 * via picker, watcher, or save.
 */
export function trackRowToUnifiedTrack(row: TrackRow): LibraryTrack {
  const artists = artistsJsonSchema.parse(JSON.parse(row.artists));
  return {
    id: `${row.source}:${row.source_id}`,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    artists,
    durationMs: row.duration_ms,
    ...(row.album !== null && { album: row.album }),
    ...(row.artwork_url !== null && { artwork: row.artwork_url }),
    ...(row.isrc !== null && { isrc: row.isrc }),
  };
}
