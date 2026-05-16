/**
 * Channel constants, hand-written types, and the bridge shape.
 *
 * This file deliberately has zero imports — preload's sandboxed
 * context can't `require()` arbitrary node_modules, and pulling in
 * even one (e.g. `zod` via the schemas in contracts.ts) breaks
 * preload load.
 *
 * Optional fields use `T | undefined` rather than just `T?`. Under
 * `exactOptionalPropertyTypes: true` those are different types: the
 * former allows the property to be present-with-undefined, the latter
 * requires it to be either missing or present-with-T. Zod's
 * `.optional()` produces the `T | undefined` shape, so the schemas in
 * contracts.ts can `satisfies` against these types only if we match
 * that shape here.
 */

// --- Channel names --------------------------------------------------------

export const CHANNELS = {
  libraryImport: 'library:import',
  libraryList: 'library:list',
  /**
   * Main → renderer push. Signal-only (no payload): the watcher and
   * youtube:save fire this after any add/unlink/save so the renderer
   * can re-fetch via `library:list`. Delta payloads are a future
   * optimization.
   */
  libraryChanged: 'library:changed',
  /**
   * Paste-and-save for YouTube. Renderer hands main a URL string;
   * main parses the videoId, fetches oEmbed metadata, upserts a row,
   * and returns a discriminated result.
   */
  youtubeSave: 'youtube:save',
  /**
   * Open a URL in the system default browser. Allowlisted in main:
   * only YouTube watch URLs pass. Used by the click-time-unplayability
   * affordance in NowPlayingBar.
   */
  systemOpenExternal: 'system:open-external',
  /**
   * Spotify auth surface. All four request/response channels use Zod-
   * validated payloads (see contracts.ts); the push channel below is
   * signal-only.
   */
  spotifyConnect: 'spotify:connect',
  spotifyDisconnect: 'spotify:disconnect',
  spotifyStatus: 'spotify:status',
  spotifyGetToken: 'spotify:get-token',
  /**
   * Paste-and-save / paste-and-import for Spotify. Renderer hands
   * main a URI or HTTPS URL; main parses, dispatches on the kind
   * (track → fetch metadata + upsert one row; playlist or album →
   * paginated import of all playable tracks, broadcasting
   * library:changed per page so Recently Added populates
   * incrementally). Single IPC channel for all three flavors —
   * input shape disambiguates downstream.
   */
  spotifySave: 'spotify:save',
  /**
   * Main → renderer push. Signal-only (no payload): fires after any
   * connection state change (connect, disconnect, refresh-failure).
   * Renderer re-fetches via `spotify:status`. Mirrors the
   * `library:changed` bridge shape exactly.
   */
  spotifyStatusChanged: 'spotify:status-changed',
  /**
   * User-defined playlist surface. Eight request/response channels
   * for CRUD on `playlists` + `playlist_tracks`, plus a signal-only
   * push channel for change broadcasts.
   *
   *   - `create` / `rename`: discriminated-union output —
   *     `{ kind: 'created' | 'renamed', playlist }` on success,
   *     `{ kind: 'invalid-name', reason }` on validation failure.
   *   - `delete` / `add-tracks` / `remove-tracks` / `reorder`:
   *     plain success (add-tracks returns a structured
   *     `{ added, skipped }` count — the partial-success is
   *     meaningful for inline UX).
   *   - `list` / `get`: read-only.
   *
   * After every successful mutation, main broadcasts
   * `playlist:changed`. Renderer re-fetches via the request/response
   * channels — same shape as `library:changed`.
   */
  playlistCreate: 'playlist:create',
  playlistRename: 'playlist:rename',
  playlistDelete: 'playlist:delete',
  playlistList: 'playlist:list',
  playlistGet: 'playlist:get',
  playlistAddTracks: 'playlist:add-tracks',
  playlistRemoveTracks: 'playlist:remove-tracks',
  playlistReorder: 'playlist:reorder',
  playlistChanged: 'playlist:changed',
} as const;

// --- Track shape (shared) -------------------------------------------------

/**
 * The over-the-wire track shape used across `library:list` and any
 * channel that returns a track. Carries rows from any source —
 * local, youtube, and spotify.
 *
 * Structurally compatible with renderer-side UnifiedTrack. The
 * renderer's library.ts wrapper validates the over-the-wire payload
 * via Zod and converts to UnifiedTrack at the boundary (the wire
 * shape uses `T | undefined` for optionals; UnifiedTrack uses `T?`,
 * which under exactOptionalPropertyTypes is a strictly different
 * type).
 */
export type LibraryTrack = {
  readonly id: string;
  readonly source: 'local' | 'youtube' | 'spotify';
  readonly sourceId: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly durationMs: number;
  readonly album?: string | undefined;
  readonly artwork?: string | undefined;
  readonly isrc?: string | undefined;
};

/**
 * Identifier-only reference to a library track — the `(source, sourceId)`
 * pair that uniquely keys a row. The paste-and-save / paste-and-import
 * responses carry the set of refs that landed in the library, so the
 * picker's auto-select logic can match against `availableTracks`
 * deterministically rather than diffing a library snapshot.
 *
 * Same shape as the per-track ref inside `PlaylistAddTracksInput.tracks`;
 * the type is named here so callers don't anonymously redeclare it.
 * Wire-shape: `T | undefined` is not relevant — both fields are
 * non-optional.
 */
export type TrackRef = {
  readonly source: 'local' | 'youtube' | 'spotify';
  readonly sourceId: string;
};

// --- library:import -------------------------------------------------------

/** Result of a successful import, or null if the user cancelled. */
export type LibraryImportOutput = LibraryTrack | null;

// --- library:list --------------------------------------------------------

/**
 * Every indexed track, ordered newest-first by `created_at`.
 * Sort is part of the contract; the renderer should not re-sort.
 * Mixes sources (local + youtube etc.) — the renderer's library view
 * doesn't distinguish.
 */
export type LibraryListOutput = readonly LibraryTrack[];

// --- youtube:save --------------------------------------------------------

export type YouTubeSaveInput = {
  readonly url: string;
};

/**
 * Discriminated result of a paste-and-save.
 *
 *   - 'saved'             — full success; track upserted with real
 *                           title + artwork. `refs` carries the
 *                           `(source, sourceId)` of the persisted row
 *                           (single-element array, by construction —
 *                           YouTube saves are one-track-per-paste);
 *                           the picker's paste-to-add path reads it
 *                           uniformly with the bulk import shape.
 *   - 'embed-restricted'  — video exists but embedding is disabled by
 *                           the uploader (oEmbed returns 401). The
 *                           row is saved with placeholder title and
 *                           null artwork; playback may fail click-
 *                           time, which NowPlayingBar handles. No
 *                           `refs` field: the picker's auto-select
 *                           callback fires only for fully-successful
 *                           saves, and embed-restricted is a degraded
 *                           outcome the URL pill signals separately.
 *   - 'not-found'         — video is deleted or private (oEmbed 404).
 *                           No row saved.
 *
 * The renderer renders different inline states for each.
 */
export type YouTubeSaveOutput =
  | {
      readonly kind: 'saved';
      readonly track: LibraryTrack;
      readonly refs: readonly TrackRef[];
    }
  | { readonly kind: 'embed-restricted'; readonly track: LibraryTrack }
  | { readonly kind: 'not-found' };

// --- system:open-external ------------------------------------------------

export type SystemOpenExternalInput = {
  readonly url: string;
};

// --- spotify:* (auth surface) -------------------------------------------

/**
 * Public connection state. Discriminated by `kind`. Mirrors the type
 * in electron/main/spotify/auth.ts; the contracts.ts Zod schema is
 * the structural enforcement.
 *
 * Variants:
 *   - 'disconnected' — no stored tokens.
 *   - 'connecting'   — OAuth flow in progress (set optimistically by
 *                      the renderer; main never returns this from the
 *                      request/response channels, since by the time
 *                      `spotify:connect` resolves the connect has
 *                      settled one way or the other).
 *   - 'connected'    — tokens stored; email shown on the Connections
 *                      row.
 *   - 'error'        — last attempt failed; message is suitable for
 *                      display under the Connect button.
 */
export type SpotifyStatus =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly email: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Result of `spotify:get-token`. Two variants:
 *   - 'connected'     — fresh access token, refreshed if needed.
 *   - 'not-connected' — no tokens stored or refresh failed.
 *
 * Adapter (3a-iii) will be the primary consumer; this slice just
 * needs the IPC pipe in place so devtools can prove the flow works.
 */
export type SpotifyTokenResult =
  | { readonly kind: 'connected'; readonly accessToken: string }
  | { readonly kind: 'not-connected' };

// --- spotify:save -------------------------------------------------------

export type SpotifySaveInput = {
  /**
   * Raw user input. Accepted shapes (track, playlist, or album):
   *   - spotify:{track,playlist,album}:<22b62>
   *   - https://open.spotify.com/{track,playlist,album}/<22b62>[?...]
   *   - open.spotify.com/{track,playlist,album}/<22b62>  (scheme-less)
   * Parsed and validated in main; rejection becomes 'invalid-input'.
   * Main dispatches on kind: tracks return 'saved'; playlists and
   * albums return 'imported' with the per-import totals.
   */
  readonly input: string;
};

/**
 * Discriminated result of a Spotify paste-and-save / paste-and-import.
 *
 *   - 'saved'           — track-input full success; row upserted with
 *                         Web API metadata. Track is returned for
 *                         inline UX. `refs` is a single-element array
 *                         carrying `{ source: 'spotify', sourceId }`
 *                         for the persisted row — same shape as the
 *                         bulk 'imported' refs so the picker's
 *                         paste-to-add reconciliation reads both
 *                         uniformly.
 *   - 'imported'        — playlist or album full success; all tracks
 *                         upserted via the per-page broadcast pipeline.
 *                         `imported` is the count of playable tracks
 *                         persisted; `skipped` counts tombstoned and
 *                         is_local items (playlists) or region-
 *                         unplayable items (albums) the source
 *                         filtered out; `truncated` is true iff the
 *                         playlist exceeded the 10,000-track hard cap
 *                         (albums effectively never trigger this).
 *                         `refs` is the full list of refs for tracks
 *                         resident in the library as a result of this
 *                         import — INCLUDING refs
 *                         whose upsert was an INSERT OR IGNORE
 *                         conflict-skip (the row was already in the
 *                         library; the ref is still library-resident
 *                         and the picker should still auto-select
 *                         it). The `imported` and `skipped` counts
 *                         describe the upsert outcome; `refs`
 *                         describes the input set's library-resident
 *                         shape. The imported tracks themselves
 *                         don't ride this response — they arrive via
 *                         the existing `library:changed` push channel
 *                         — so the renderer's state wrapper passes
 *                         the totals through to the SpotifyUrlInput
 *                         component.
 *   - 'auth-required'   — no stored Spotify tokens, or token refresh
 *                         failed. Renderer points user at the
 *                         Connections row.
 *   - 'invalid-input'   — input didn't parse as a track, playlist,
 *                         or album URI/URL. Could be an artist URL,
 *                         malformed string, etc.
 *   - 'not-found'       — Web API returned 404 for the parsed
 *                         trackId or playlistId. Track was deleted /
 *                         never existed, or playlist is private to
 *                         someone else / deleted.
 *   - 'network-error'   — fetch failed (offline, 5xx, rate limit,
 *                         schema mismatch). User can retry.
 *
 * Mirrors `YouTubeSaveOutput`'s shape conceptually — the renderer
 * branches on `kind` to choose inline messaging.
 */
export type SpotifySaveOutput =
  | {
      readonly kind: 'saved';
      readonly track: LibraryTrack;
      readonly refs: readonly TrackRef[];
    }
  | {
      readonly kind: 'imported';
      readonly imported: number;
      readonly skipped: number;
      readonly truncated: boolean;
      readonly refs: readonly TrackRef[];
    }
  | { readonly kind: 'auth-required' }
  | { readonly kind: 'invalid-input' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'network-error' };

// --- playlist:* ----------------------------------------------------------

/**
 * Playlist header — id + name + the two timestamps. The shared shape
 * across `create`, `rename`, `list` (extended), and `get` (extended).
 */
export type Playlist = {
  readonly id: number;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * List-row shape — header + the track count. Used by `playlist:list`
 * so the UI can render "N tracks" without fetching contents.
 */
export type PlaylistSummary = Playlist & {
  readonly trackCount: number;
};

/**
 * One membership row in a playlist's detail view. Carries the full
 * library track (so UI can render tiles directly) plus the
 * surrogate `playlistTrackId` (which the renderer uses to address
 * a single membership row across remove / reorder) and `position`.
 */
export type PlaylistMembership = {
  readonly playlistTrackId: number;
  readonly position: number;
  readonly track: LibraryTrack;
};

/**
 * Detail-view shape — header + the ordered list of memberships.
 * Returned from `playlist:get`. `null` when the id doesn't exist.
 */
export type PlaylistDetail = Playlist & {
  readonly tracks: readonly PlaylistMembership[];
};

// --- playlist:create -----------------------------------------------------

export type PlaylistCreateInput = {
  readonly name: string;
};

/**
 * Discriminated result of a create. Mirrors `SpotifySaveOutput`'s
 * shape for the validation case.
 *
 *   - 'created'      — the playlist was inserted.
 *   - 'invalid-name' — name was empty / whitespace-only / over the
 *                      256-char limit. Renderer renders inline.
 */
export type PlaylistCreateOutput =
  | { readonly kind: 'created'; readonly playlist: Playlist }
  | {
      readonly kind: 'invalid-name';
      readonly reason: 'empty' | 'too-long';
    };

// --- playlist:rename -----------------------------------------------------

export type PlaylistRenameInput = {
  readonly id: number;
  readonly name: string;
};

/**
 * Discriminated result of a rename. Same validation variant as
 * create; success returns the updated playlist row so the
 * renderer can drop it straight into store state.
 *
 * Unknown id is signaled by a rejected promise rather than a
 * discriminated variant — there's no UX path "rename failed,
 * stay on the detail page" (the page is for that id; if the id
 * vanished, the page should already be navigating away).
 */
export type PlaylistRenameOutput =
  | { readonly kind: 'renamed'; readonly playlist: Playlist }
  | {
      readonly kind: 'invalid-name';
      readonly reason: 'empty' | 'too-long';
    };

// --- playlist:delete -----------------------------------------------------

export type PlaylistDeleteInput = {
  readonly id: number;
};
/**
 * Delete is idempotent: deleting an unknown id is not an error.
 * Output is plain success; renderer treats every signal as
 * "navigate away from this detail page if it was this id."
 */
export type PlaylistDeleteOutput = void;

// --- playlist:list -------------------------------------------------------

export type PlaylistListOutput = readonly PlaylistSummary[];

// --- playlist:get --------------------------------------------------------

export type PlaylistGetInput = {
  readonly id: number;
};

/** `null` when the id doesn't exist (matches the db helper). */
export type PlaylistGetOutput = PlaylistDetail | null;

// --- playlist:add-tracks -------------------------------------------------

export type PlaylistAddTracksInput = {
  readonly id: number;
  readonly tracks: readonly {
    readonly source: 'local' | 'youtube' | 'spotify';
    readonly sourceId: string;
  }[];
};

/**
 * Structured success rather than `void` because the partial-success
 * is meaningful to the caller: when some refs target tracks that
 * aren't in the library, they're silently skipped, and the count
 * lets the UI surface "added N (skipped M)" inline.
 */
export type PlaylistAddTracksOutput = {
  readonly added: number;
  readonly skipped: number;
};

// --- playlist:remove-tracks ----------------------------------------------

export type PlaylistRemoveTracksInput = {
  readonly id: number;
  readonly playlistTrackIds: readonly number[];
};
export type PlaylistRemoveTracksOutput = {
  readonly removed: number;
};

// --- playlist:reorder ----------------------------------------------------

export type PlaylistReorderInput = {
  readonly id: number;
  /**
   * The full ordered list of `playlistTrackId`s after reorder. Length
   * must match the current playlist size and the set must match
   * exactly — main validates before mutating; mismatch rejects.
   */
  readonly orderedPlaylistTrackIds: readonly number[];
};
export type PlaylistReorderOutput = void;

// --- library:changed (push) ----------------------------------------------

/**
 * Handle for tearing down a main → renderer push subscription. Kept as
 * a plain type alias here (rather than a separate `Unsubscribe` export)
 * because the only consumer is the bridge surface below and channels.ts
 * stays minimal by convention.
 */
type Unsubscribe = () => void;

// --- Bridge surface (window.musaic) ---------------------------------------

export type MusaicBridge = {
  readonly library: {
    importFile(): Promise<LibraryImportOutput>;
    list(): Promise<LibraryListOutput>;
    /**
     * Subscribe to library:changed signals from main. Returns the
     * handle used to detach the listener — same shape as
     * `PlaybackAdapter.on`. Signal-only: the callback receives no
     * arguments.
     */
    onChanged(cb: () => void): Unsubscribe;
  };
  readonly youtube: {
    /** Paste-and-save flow; see YouTubeSaveOutput. */
    save(input: YouTubeSaveInput): Promise<YouTubeSaveOutput>;
  };
  readonly system: {
    /**
     * Open a URL in the system browser. URL is allowlisted in main —
     * non-allowlisted URLs reject. See electron/main/ipc/system.ts.
     */
    openExternal(input: SystemOpenExternalInput): Promise<void>;
  };
  readonly spotify: {
    /**
     * Begin a connect flow. Opens the system browser to Spotify's
     * authorize URL, awaits the redirect on the loopback callback
     * server, exchanges the code, persists tokens, returns the new
     * connection status. Concurrent calls reject with the
     * `error` status variant rather than starting a second flow.
     */
    connect(): Promise<SpotifyStatus>;
    /** Clear stored tokens. Idempotent. */
    disconnect(): Promise<void>;
    /** Read-only status accessor. Never network-hits except for the
     *  cold-launch /me lookup when tokens exist but no email is cached. */
    status(): Promise<SpotifyStatus>;
    /**
     * Get a current access token, refreshing if it's about to expire.
     * Returns `{ kind: 'not-connected' }` if no tokens are stored or
     * refresh fails — the latter case also flips the status to
     * disconnected.
     */
    getToken(): Promise<SpotifyTokenResult>;
    /**
     * Subscribe to connection-state changes. Signal-only — the
     * callback receives no arguments; the renderer re-fetches via
     * `status()` on signal. Same shape as `library.onChanged`.
     */
    onStatusChanged(cb: () => void): Unsubscribe;
    /**
     * Paste-and-save a Spotify track URI or HTTPS URL. Returns a
     * discriminated result; the input component renders inline
     * states keyed to the `kind`. See SpotifySaveOutput for the
     * variants.
     */
    save(input: SpotifySaveInput): Promise<SpotifySaveOutput>;
  };
  readonly playlist: {
    /**
     * Create a playlist with the given name. Validates name (1-256
     * chars after trim); returns `{ kind: 'invalid-name', reason }`
     * on failure rather than rejecting the promise.
     */
    create(input: PlaylistCreateInput): Promise<PlaylistCreateOutput>;
    /**
     * Rename an existing playlist. Same validation as create.
     * Rejects (not invalid-name) when the id doesn't exist — the
     * renderer treats that as a "stale view" case and re-fetches.
     */
    rename(input: PlaylistRenameInput): Promise<PlaylistRenameOutput>;
    /**
     * Delete a playlist. Idempotent (deleting an unknown id is not
     * an error). Cascades to membership rows via FK.
     */
    delete(input: PlaylistDeleteInput): Promise<PlaylistDeleteOutput>;
    /** Read every playlist as `(id, name, trackCount, timestamps)`. */
    list(): Promise<PlaylistListOutput>;
    /** Read a single playlist with its ordered tracks. */
    get(input: PlaylistGetInput): Promise<PlaylistGetOutput>;
    /**
     * Append one or more tracks to a playlist. Refs that target
     * tracks not in the library are silently skipped and surfaced
     * as a count — the partial success is meaningful UX.
     */
    addTracks(input: PlaylistAddTracksInput): Promise<PlaylistAddTracksOutput>;
    /**
     * Remove one or more tracks from a playlist by their surrogate
     * `playlistTrackId`. Renumbers remaining positions to close
     * gaps so the dense-int invariant holds.
     */
    removeTracks(
      input: PlaylistRemoveTracksInput,
    ): Promise<PlaylistRemoveTracksOutput>;
    /**
     * Reorder a playlist to match the given full ordered list of
     * `playlistTrackId`s. Rejects if the input is missing ids, has
     * extras, or contains duplicates.
     */
    reorder(input: PlaylistReorderInput): Promise<PlaylistReorderOutput>;
    /**
     * Subscribe to `playlist:changed` signals from main. Mirrors
     * `library.onChanged` exactly: signal-only, returns an
     * unsubscribe handle. Fires after every successful mutation.
     */
    onChanged(cb: () => void): Unsubscribe;
  };
};
