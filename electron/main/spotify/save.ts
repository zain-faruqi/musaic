/**
 * Paste-and-save / paste-and-import pipelines for Spotify.
 *
 * Three functions, all directly testable:
 *   - `saveSpotifyTrack(parsed, deps)`        — single track upsert.
 *   - `importSpotifyPlaylist(parsed, deps)`   — playlist track import.
 *   - `importSpotifyAlbum(parsed, deps)`      — album track import (5a).
 *
 * All take a *parsed* input shape rather than a raw string. The IPC
 * handler in electron/main/ipc/spotify.ts parses the user-supplied
 * input once via `parseSpotifyInput` and dispatches on the resulting
 * discriminant; downstream functions then can't accidentally re-
 * dispatch and a missed-case shows up as a TypeScript error.
 *
 * Accepts track, playlist, and album inputs via a discriminated
 * union. The signature is `(parsed, deps)`. Mirrors
 * electron/main/youtube/save.ts in spirit
 * but adopts the parsed-input shape that the discriminated dispatch
 * makes natural.
 *
 * The album importer mirrors the playlist importer almost exactly
 * — same outcome variant (`'imported'`), same `library:changed`
 * per-page broadcast, same
 * idempotent upsert. The wire-shape difference between album track
 * items and playlist track items is absorbed by web-api.ts'
 * `fetchAlbumTracks`; this layer just delegates to it.
 *
 * `refs` is plumbed through every success variant:
 *   - `saveSpotifyTrack` returns `refs: [{ source: 'spotify',
 *     sourceId: parsed.uri }]` in its `'saved'` outcome.
 *   - `buildPerPageUpsert` accumulates a per-page refs array (every
 *     upserted track, including conflict-skip rows that were already
 *     in the library — the row is library-resident either way).
 *   - The shared bulk outcome type `ImportBulkOutcome` (renamed from
 *     the 5a-historical `ImportPlaylistOutcome` — the name was wrong
 *     for albums and gains a third semantic load now) carries `refs`
 *     on its `'imported'` variant; the IPC handler in
 *     `electron/main/ipc/spotify.ts` forwards them onto
 *     `SpotifySaveOutput`.
 *
 * Track flow:
 *   1. Get access token via deps.getToken().
 *      → null → 'auth-required'
 *   2. Fetch Web API metadata.
 *      → SpotifyTrackError, reason='not-found'     → 'not-found'
 *      → SpotifyTrackError, reason='auth-required' → 'auth-required'
 *      → SpotifyTrackError, reason='rate-limited'  → 'network-error'
 *      → SpotifyTrackError, reason='network'       → 'network-error'
 *   3. Upsert the row; return 'saved' with the track and refs.
 *
 * Playlist / album flow:
 *   1. Get access token.
 *   2. Call fetchPlaylistTracks / fetchAlbumTracks with a per-page hook.
 *   3. For each page: upsert all tracks with added_at = baseTime + i,
 *      push each `(source, sourceId)` onto the refs accumulator,
 *      then broadcast library:changed.
 *   4. Return { imported, skipped, truncated, refs }.
 *
 * No partial-save path: unlike YouTube's `embed-restricted` (which
 * persists a placeholder so the user can still click the tile),
 * Spotify has no shape that maps to "row exists but doesn't play."
 * If metadata fetch fails for a track save, we don't persist; the
 * user retries after fixing the cause.
 *
 * For playlist / album imports, a mid-import failure throws (the IPC
 * handler translates it to the response variant); already-upserted
 * pages stay in the library, since the user has seen them populate
 * via library:changed. Re-pasting the input after a recovery
 * idempotently fills in the missing tracks (upsert preserves
 * created_at).
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  ParsedSpotifyAlbum,
  ParsedSpotifyPlaylist,
  ParsedSpotifyTrack,
} from './parse-uri';
import type {
  LibraryTrack,
  SpotifySaveOutput,
  TrackRef,
} from '../../ipc/channels';
import { trackRowToUnifiedTrack, type TrackRow } from '../db/schema';
import { upsertTrack, getTrack } from '../db/tracks';
import {
  fetchAlbumTracks,
  fetchPlaylistTracks,
  fetchTrackMetadata,
  SpotifyTrackError,
  type PlaylistImportResult,
  type SpotifyTrackMetadata,
} from './web-api';

/**
 * Type of the get-access-token seam. Returns null if no tokens are
 * stored or refresh failed. Production callers pass the real
 * `getAccessToken` from auth.ts; tests inject a stub.
 */
export type GetAccessToken = () => Promise<string | null>;

/**
 * Type of the fetch-track-metadata seam. Production callers pass the
 * real `fetchTrackMetadata` from web-api.ts; tests inject a stub
 * that throws SpotifyTrackError for the error-mapping cases. The
 * wrapped signature collapses the fetchImpl indirection.
 */
export type FetchSpotifyMetadata = (
  trackId: string,
  accessToken: string,
) => Promise<SpotifyTrackMetadata>;

/**
 * Type of the fetch-playlist-tracks seam. Same shape as the real
 * web-api function with the fetchImpl and per-page-callback
 * parameters collapsed; the save layer supplies the callback inline.
 */
export type FetchSpotifyPlaylist = (
  playlistId: string,
  accessToken: string,
  onPageDecoded: (
    pageTracks: readonly SpotifyTrackMetadata[],
    pageIndex: number,
  ) => void | Promise<void>,
) => Promise<PlaylistImportResult>;

/**
 * Type of the fetch-album-tracks seam. Structurally
 * identical to `FetchSpotifyPlaylist`: the production function lives
 * in web-api.ts and the save layer collapses the `fetchImpl`
 * indirection by injecting its own callback. Kept as a distinct
 * type alias for clarity at call sites; the page-callback semantics
 * are the same.
 */
export type FetchSpotifyAlbum = (
  albumId: string,
  accessToken: string,
  onPageDecoded: (
    pageTracks: readonly SpotifyTrackMetadata[],
    pageIndex: number,
  ) => void | Promise<void>,
) => Promise<PlaylistImportResult>;

// --- saveSpotifyTrack ---------------------------------------------------

export type SaveTrackDeps = {
  readonly db: DatabaseSync;
  readonly getToken: GetAccessToken;
  /** Defaults to the real `fetchTrackMetadata` from web-api.ts. */
  readonly fetchMetadata?: FetchSpotifyMetadata;
  /** Defaults to `Date.now()`. Tests pin this to deterministic values. */
  readonly now?: number;
};

/**
 * Save a single parsed Spotify track URI to the library.
 *
 * On upsert conflict, `created_at` is preserved (mtime updates).
 * Matches the YouTube paste-and-save pattern: re-pasting the same
 * track does not bump it to the top of Recently Added.
 *
 * `source_id` stores the canonical URI (`spotify:track:<id>`), not
 * the bare trackId — the `sourceId` invariant is "the Spotify URI".
 * SpotifyAdapter sends `{ uris: [sourceId] }`
 * directly to PUT /me/player/play; the API specifically wants the
 * URI form. Migration 0004 canonicalizes any pre-fix rows.
 */
export async function saveSpotifyTrack(
  parsed: ParsedSpotifyTrack,
  deps: SaveTrackDeps,
): Promise<SpotifySaveOutput> {
  const fetchMetadata: FetchSpotifyMetadata =
    deps.fetchMetadata ?? ((id, token) => fetchTrackMetadata(id, token));
  const now = deps.now ?? Date.now();

  const accessToken = await deps.getToken();
  if (accessToken === null) {
    return { kind: 'auth-required' };
  }

  let metadata: SpotifyTrackMetadata;
  try {
    metadata = await fetchMetadata(parsed.trackId, accessToken);
  } catch (err) {
    if (err instanceof SpotifyTrackError) {
      switch (err.reason) {
        case 'not-found':
          return { kind: 'not-found' };
        case 'auth-required':
          // Token revoked between getToken() and the API call.
          // Surfacing as auth-required points the user at the
          // Connections row; main's auth module will clear the
          // stale tokens on the next getAccessToken call.
          return { kind: 'auth-required' };
        case 'rate-limited':
        case 'network':
          return { kind: 'network-error' };
      }
    }
    // Anything not a SpotifyTrackError is genuinely unexpected —
    // re-throw and let the IPC handler surface as a rejected promise.
    throw err;
  }

  const existing = getTrack(deps.db, 'spotify', parsed.uri);
  const createdAt = existing?.created_at ?? now;

  const row: TrackRow = {
    source: 'spotify',
    source_id: parsed.uri,
    path: null,
    title: metadata.title,
    artists: JSON.stringify(metadata.artists),
    album: metadata.album,
    duration_ms: metadata.durationMs,
    isrc: metadata.isrc ?? null,
    artwork_url: metadata.artworkUrl ?? null,
    mtime: now,
    created_at: createdAt,
  };
  upsertTrack(deps.db, row);
  const track: LibraryTrack = trackRowToUnifiedTrack(row);
  // Single-element refs array. Mirrors the bulk-import
  // shape so the picker's paste-to-add path reads `refs` uniformly
  // across both flavors.
  return {
    kind: 'saved',
    track,
    refs: [{ source: 'spotify', sourceId: parsed.uri }],
  };
}

// --- importSpotifyPlaylist / importSpotifyAlbum -------------------------

export type ImportBulkResult = {
  readonly imported: number;
  readonly skipped: number;
  readonly truncated: boolean;
  /**
   * `(source, sourceId)` of every track in the input set that is
   * library-resident as a result of this import. INCLUDES
   * refs whose upsert was an `INSERT OR IGNORE` conflict-skip — those
   * rows were already in the library, but the picker still wants to
   * auto-select them (they ARE library tracks). Ordering matches the
   * Spotify-reported track order (page-major, in-page index minor).
   */
  readonly refs: readonly TrackRef[];
};

/**
 * Discriminated outcome of an import attempt. The IPC handler maps
 * each non-'imported' variant to the corresponding SpotifySaveOutput
 * shape; 'imported' carries through with the totals and refs.
 *
 * 'auth-required' and 'not-found' surface the same way they do for
 * single-track saves. 'network-error' covers fetch throws, 5xx
 * responses, schema mismatch, and 429-after-Retry-After exhaustion.
 *
 * Used by both the playlist and album importers; the name reflects
 * that this is a generic import outcome, not a playlist-specific one.
 * `ImportBulkOutcome` reflects that the shape covers any paginated
 * bulk-import flow regardless of source kind.
 */
export type ImportBulkOutcome =
  | { readonly kind: 'imported'; readonly result: ImportBulkResult }
  | { readonly kind: 'auth-required' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'network-error' };

export type ImportPlaylistDeps = {
  readonly db: DatabaseSync;
  readonly getToken: GetAccessToken;
  /**
   * Broadcaster for library:changed. Called after each page is
   * upserted so the renderer's library store re-fetches and the user
   * sees Recently Added populate as the import runs.
   */
  readonly broadcast: () => void;
  /** Defaults to the real `fetchPlaylistTracks` from web-api.ts. */
  readonly fetchPlaylist?: FetchSpotifyPlaylist;
  /** Defaults to `Date.now()`. Tests pin to deterministic values. */
  readonly now?: number;
};

/**
 * Same shape as `ImportPlaylistDeps`, just with the album-fetcher
 * seam. Two type aliases keep call sites self-documenting.
 */
export type ImportAlbumDeps = {
  readonly db: DatabaseSync;
  readonly getToken: GetAccessToken;
  readonly broadcast: () => void;
  /** Defaults to the real `fetchAlbumTracks` from web-api.ts. */
  readonly fetchAlbum?: FetchSpotifyAlbum;
  readonly now?: number;
};

/**
 * Build a per-page upsert-and-broadcast callback plus a refs
 * accumulator. Shared by the playlist and album importers since the
 * per-page work is identical:
 *   - each track in the page is upserted with `added_at = baseTime +
 *     i`,
 *   - its `(source, sourceId)` is pushed onto the refs accumulator
 *     (including conflict-skip cases; the picker's auto-select
 *     wants the ref regardless of whether the upsert was an insert
 *     or a skip),
 *   - the running index is threaded across pages so order is globally
 *     consistent,
 *   - the broadcast fires once per non-empty page.
 *
 * Returns a tuple `[onPage, refs]` where `refs` is the mutable
 * accumulator the caller reads when the import finishes. One
 * builder instance is consumed by exactly one import run.
 */
const buildPerPageUpsert = (
  db: DatabaseSync,
  broadcast: () => void,
  baseTime: number,
): readonly [
  (pageTracks: readonly SpotifyTrackMetadata[]) => void,
  TrackRef[],
] => {
  let runningIndex = 0;
  const refs: TrackRef[] = [];
  const onPage = (pageTracks: readonly SpotifyTrackMetadata[]): void => {
    for (const meta of pageTracks) {
      const existing = getTrack(db, 'spotify', meta.uri);
      const createdAt = existing?.created_at ?? baseTime + runningIndex;

      const row: TrackRow = {
        source: 'spotify',
        source_id: meta.uri,
        path: null,
        title: meta.title,
        artists: JSON.stringify(meta.artists),
        album: meta.album,
        duration_ms: meta.durationMs,
        isrc: meta.isrc ?? null,
        artwork_url: meta.artworkUrl ?? null,
        mtime: baseTime + runningIndex,
        created_at: createdAt,
      };
      upsertTrack(db, row);
      refs.push({ source: 'spotify', sourceId: meta.uri });
      runningIndex += 1;
    }
    // Per-page broadcast. Even if the page contributed zero playable
    // tracks (all tombstoned / is_local / unplayable), we don't
    // broadcast — there's nothing for the renderer to display.
    if (pageTracks.length > 0) {
      broadcast();
    }
  };
  return [onPage, refs];
};

/**
 * Map a thrown `SpotifyTrackError` to the corresponding
 * `ImportBulkOutcome` variant. Anything else re-throws — only
 * categorized failures collapse to outcomes; surprises are
 * surfaced to the IPC layer as a rejected promise.
 */
const mapImportError = (err: unknown): ImportBulkOutcome => {
  if (err instanceof SpotifyTrackError) {
    switch (err.reason) {
      case 'not-found':
        return { kind: 'not-found' };
      case 'auth-required':
        return { kind: 'auth-required' };
      case 'rate-limited':
      case 'network':
        return { kind: 'network-error' };
    }
  }
  throw err;
};

/**
 * Import all tracks from a parsed Spotify playlist URI/URL.
 *
 * `added_at` strategy: every imported track gets `baseTime + index`
 * milliseconds. Preserves playlist order in `/ Recently Added` —
 * track 1 at baseTime, track 2 at baseTime+1ms, …, baseTime+N. The
 * Spotify-reported `added_at` (when the track was added to the
 * playlist, possibly years ago) is intentionally NOT used: the
 * user's intent on paste is "I want to listen to this playlist now",
 * so the playlist should surface as a contiguous block at the top
 * of Recently Added.
 *
 * Idempotency: upsert preserves `created_at` on conflict. Re-pasting
 * the same playlist does not re-shuffle Recently Added. If a track
 * was already in the library before this import, it keeps its
 * existing position; only newly-added tracks land at top. Documented
 * acceptable-v1 behavior — the "scattered position" case is the
 * single-already-imported-track edge.
 *
 * Per-page broadcast: each Spotify-API page (100 tracks) becomes one
 * library:changed signal so the user sees Recently Added populate
 * incrementally rather than after a long silent wait. Same channel
 * as the watcher and youtube:save use — no new push channel.
 */
export async function importSpotifyPlaylist(
  parsed: ParsedSpotifyPlaylist,
  deps: ImportPlaylistDeps,
): Promise<ImportBulkOutcome> {
  const fetchPlaylist: FetchSpotifyPlaylist =
    deps.fetchPlaylist ??
    ((id, token, onPage) => fetchPlaylistTracks(id, token, undefined, onPage));
  const baseTime = deps.now ?? Date.now();

  const accessToken = await deps.getToken();
  if (accessToken === null) {
    return { kind: 'auth-required' };
  }

  const [onPageDecoded, refs] = buildPerPageUpsert(
    deps.db,
    deps.broadcast,
    baseTime,
  );

  let result: PlaylistImportResult;
  try {
    result = await fetchPlaylist(parsed.playlistId, accessToken, onPageDecoded);
  } catch (err) {
    return mapImportError(err);
  }

  return {
    kind: 'imported',
    result: {
      imported: result.tracks.length,
      skipped: result.skipped,
      truncated: result.truncated,
      refs,
    },
  };
}

/**
 * Import all tracks from a parsed Spotify album URI/URL.
 *
 * Mirrors `importSpotifyPlaylist` in every respect — same outcome
 * shape, same `added_at` semantics, same per-page broadcast pattern,
 * same idempotent upsert behavior. The only difference is the fetch
 * seam (`fetchAlbumTracks` vs `fetchPlaylistTracks`); the wire-level
 * shape difference between album track items and playlist track
 * items is absorbed inside web-api.ts.
 *
 * Albums almost never paginate (Spotify caps album length around 100
 * tracks, well below the 10,000-track import cap), so `truncated`
 * effectively never fires for albums — but the field is preserved
 * in the response shape for consistency with playlists.
 *
 * No new OAuth scope required — albums are public catalog data and
 * the standard user-bound token has access.
 */
export async function importSpotifyAlbum(
  parsed: ParsedSpotifyAlbum,
  deps: ImportAlbumDeps,
): Promise<ImportBulkOutcome> {
  const fetchAlbum: FetchSpotifyAlbum =
    deps.fetchAlbum ??
    ((id, token, onPage) => fetchAlbumTracks(id, token, undefined, onPage));
  const baseTime = deps.now ?? Date.now();

  const accessToken = await deps.getToken();
  if (accessToken === null) {
    return { kind: 'auth-required' };
  }

  const [onPageDecoded, refs] = buildPerPageUpsert(
    deps.db,
    deps.broadcast,
    baseTime,
  );

  let result: PlaylistImportResult;
  try {
    result = await fetchAlbum(parsed.albumId, accessToken, onPageDecoded);
  } catch (err) {
    return mapImportError(err);
  }

  return {
    kind: 'imported',
    result: {
      imported: result.tracks.length,
      skipped: result.skipped,
      truncated: result.truncated,
      refs,
    },
  };
}
