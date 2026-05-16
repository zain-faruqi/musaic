/**
 * Runtime validation schemas for IPC payloads and responses.
 *
 * Source of truth for runtime validation; types live in channels.ts
 * (which has no imports and is therefore safe to load from the
 * sandboxed preload context).
 *
 * The `satisfies` check ties each schema to its hand-written type so
 * drift between channels.ts and the schemas here becomes a compile
 * error.
 */
import { z } from 'zod';
import type {
  LibraryImportOutput,
  LibraryListOutput,
  Playlist,
  PlaylistAddTracksInput,
  PlaylistAddTracksOutput,
  PlaylistCreateInput,
  PlaylistCreateOutput,
  PlaylistDeleteInput,
  PlaylistDetail,
  PlaylistGetInput,
  PlaylistGetOutput,
  PlaylistListOutput,
  PlaylistMembership,
  PlaylistRemoveTracksInput,
  PlaylistRemoveTracksOutput,
  PlaylistRenameInput,
  PlaylistRenameOutput,
  PlaylistReorderInput,
  PlaylistSummary,
  SpotifySaveInput,
  SpotifySaveOutput,
  SpotifyStatus,
  SpotifyTokenResult,
  SystemOpenExternalInput,
  TrackRef,
  YouTubeSaveInput,
  YouTubeSaveOutput,
} from './channels';

// Re-export everything from channels so consumers can import schemas
// and types from one place.
export {
  CHANNELS,
  type LibraryTrack,
  type LibraryImportOutput,
  type LibraryListOutput,
  type TrackRef,
  type YouTubeSaveInput,
  type YouTubeSaveOutput,
  type SystemOpenExternalInput,
  type SpotifyStatus,
  type SpotifyTokenResult,
  type SpotifySaveInput,
  type SpotifySaveOutput,
  type MusaicBridge,
  type Playlist,
  type PlaylistSummary,
  type PlaylistMembership,
  type PlaylistDetail,
  type PlaylistCreateInput,
  type PlaylistCreateOutput,
  type PlaylistRenameInput,
  type PlaylistRenameOutput,
  type PlaylistDeleteInput,
  type PlaylistDeleteOutput,
  type PlaylistListOutput,
  type PlaylistGetInput,
  type PlaylistGetOutput,
  type PlaylistAddTracksInput,
  type PlaylistAddTracksOutput,
  type PlaylistRemoveTracksInput,
  type PlaylistRemoveTracksOutput,
  type PlaylistReorderInput,
  type PlaylistReorderOutput,
} from './channels';

// --- shared atoms -------------------------------------------------------

/**
 * The source enum, used everywhere a track row (or a ref to one)
 * is validated. Extracted as a single schema so a future fourth
 * source widens here once and propagates everywhere it's used.
 */
export const sourceSchema = z.enum(['local', 'youtube', 'spotify']);

/**
 * Identifier-only reference to a track row — the `(source, sourceId)`
 * pair. Shared, exported atom because three callsites use it:
 * `playlistAddTracksInput.tracks` (per-track refs on add), and the
 * paste-and-save / paste-and-import responses (the picker's
 * paste-to-add path reads them to compute auto-select against
 * `availableTracks`). One schema, three call sites.
 */
export const trackRefSchema = z.object({
  source: sourceSchema,
  sourceId: z.string(),
}) satisfies z.ZodType<TrackRef>;

// --- library:import / library:list (shared track shape) -----------------

const libraryTrackSchema = z.object({
  id: z.string(),
  source: sourceSchema,
  sourceId: z.string(),
  title: z.string(),
  artists: z.array(z.string()).readonly(),
  durationMs: z.number().nonnegative(),
  album: z.string().optional(),
  artwork: z.string().optional(),
  isrc: z.string().optional(),
});

export const libraryImportOutput = z.union([
  libraryTrackSchema,
  z.null(),
]) satisfies z.ZodType<LibraryImportOutput>;

/**
 * The returned array is sorted by `created_at DESC` in main — the
 * schema doesn't enforce sort (Zod can't), but the contract does.
 * See electron/main/db/tracks.ts (getAllTracks).
 */
export const libraryListOutput = z
  .array(libraryTrackSchema)
  .readonly() satisfies z.ZodType<LibraryListOutput>;

// --- youtube:save --------------------------------------------------------

export const youtubeSaveInput = z.object({
  url: z.string(),
}) satisfies z.ZodType<YouTubeSaveInput>;

/**
 * Discriminated by `kind`. Two of the three variants carry a track
 * (the save persisted a row); `not-found` does not. The `'saved'`
 * variant also carries `refs` — a single-element array keying the
 * persisted row; the picker's paste-to-add path reads it to compute
 * auto-select against `availableTracks`. The `'embed-restricted'`
 * variant deliberately omits `refs`: the picker callback fires only
 * for fully-successful saves, and embed-restricted is a degraded
 * outcome the URL pill signals separately.
 */
export const youtubeSaveOutput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('saved'),
    track: libraryTrackSchema,
    refs: z.array(trackRefSchema).readonly(),
  }),
  z.object({ kind: z.literal('embed-restricted'), track: libraryTrackSchema }),
  z.object({ kind: z.literal('not-found') }),
]) satisfies z.ZodType<YouTubeSaveOutput>;

// --- system:open-external -----------------------------------------------

export const systemOpenExternalInput = z.object({
  url: z.string(),
}) satisfies z.ZodType<SystemOpenExternalInput>;

// --- spotify:* ----------------------------------------------------------

/**
 * Discriminated union mirroring SpotifyStatus from channels.ts. Both
 * inbound (response from main) and outbound (handler return) parses
 * use this — the `satisfies` check ties it to the hand-written type so
 * any drift becomes a compile error.
 */
export const spotifyStatus = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('disconnected') }),
  z.object({ kind: z.literal('connecting') }),
  z.object({ kind: z.literal('connected'), email: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]) satisfies z.ZodType<SpotifyStatus>;

/**
 * Response shape for `spotify:get-token`. The renderer never sees a
 * stale access token — main refreshes inline before returning when the
 * cached one is near expiry.
 */
export const spotifyTokenResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connected'), accessToken: z.string() }),
  z.object({ kind: z.literal('not-connected') }),
]) satisfies z.ZodType<SpotifyTokenResult>;

// --- spotify:save -------------------------------------------------------

export const spotifySaveInput = z.object({
  input: z.string(),
}) satisfies z.ZodType<SpotifySaveInput>;

/**
 * Discriminated by `kind`. The `'saved'` variant carries a track
 * (single-track paste-and-save). The `'imported'` variant carries
 * playlist-import totals (playable count, skipped count, truncation
 * flag); the imported tracks themselves arrive via library:changed.
 * Both `'saved'` and `'imported'` carry `refs` — the library-resident
 * `(source, sourceId)` keys of every track in the input set; the
 * picker's paste-to-add path reads them to compute auto-select. Refs
 * include already-in-library tracks whose upsert was an `INSERT OR
 * IGNORE` conflict-skip (the row is library-resident either way; the
 * picker still auto-selects). The rest are reason-only — the renderer
 * maps each to an inline UX state.
 */
export const spotifySaveOutput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('saved'),
    track: libraryTrackSchema,
    refs: z.array(trackRefSchema).readonly(),
  }),
  z.object({
    kind: z.literal('imported'),
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    truncated: z.boolean(),
    refs: z.array(trackRefSchema).readonly(),
  }),
  z.object({ kind: z.literal('auth-required') }),
  z.object({ kind: z.literal('invalid-input') }),
  z.object({ kind: z.literal('not-found') }),
  z.object({ kind: z.literal('network-error') }),
]) satisfies z.ZodType<SpotifySaveOutput>;

// --- playlist:* ---------------------------------------------------------

/**
 * Shared atom — the per-playlist header carried in `create`,
 * `rename`, embedded in `list` rows (with `trackCount`), and in
 * the `get` detail (with `tracks`).
 */
const playlistSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}) satisfies z.ZodType<Playlist>;

const playlistSummarySchema = playlistSchema.extend({
  trackCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<PlaylistSummary>;

const playlistMembershipSchema = z.object({
  playlistTrackId: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
  track: libraryTrackSchema,
}) satisfies z.ZodType<PlaylistMembership>;

const playlistDetailSchema = playlistSchema.extend({
  tracks: z.array(playlistMembershipSchema).readonly(),
}) satisfies z.ZodType<PlaylistDetail>;

// --- playlist:create ----------------------------------------------------

export const playlistCreateInput = z.object({
  // Length-bounded so an absurdly long input doesn't even reach the
  // db layer. The db's validateName also rejects empty/too-long
  // (after trim) — this is the boundary check, that's the canonical
  // one. Cap at the trimmed limit + slack for leading/trailing
  // whitespace; over that, fail at parse time.
  name: z.string().max(4096),
}) satisfies z.ZodType<PlaylistCreateInput>;

const invalidNameReasonSchema = z.enum(['empty', 'too-long']);

export const playlistCreateOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), playlist: playlistSchema }),
  z.object({
    kind: z.literal('invalid-name'),
    reason: invalidNameReasonSchema,
  }),
]) satisfies z.ZodType<PlaylistCreateOutput>;

// --- playlist:rename ----------------------------------------------------

export const playlistRenameInput = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().max(4096),
}) satisfies z.ZodType<PlaylistRenameInput>;

export const playlistRenameOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('renamed'), playlist: playlistSchema }),
  z.object({
    kind: z.literal('invalid-name'),
    reason: invalidNameReasonSchema,
  }),
]) satisfies z.ZodType<PlaylistRenameOutput>;

// --- playlist:delete ----------------------------------------------------

export const playlistDeleteInput = z.object({
  id: z.number().int().nonnegative(),
}) satisfies z.ZodType<PlaylistDeleteInput>;

// --- playlist:list ------------------------------------------------------

export const playlistListOutput = z
  .array(playlistSummarySchema)
  .readonly() satisfies z.ZodType<PlaylistListOutput>;

// --- playlist:get -------------------------------------------------------

export const playlistGetInput = z.object({
  id: z.number().int().nonnegative(),
}) satisfies z.ZodType<PlaylistGetInput>;

export const playlistGetOutput = z.union([
  playlistDetailSchema,
  z.null(),
]) satisfies z.ZodType<PlaylistGetOutput>;

// --- playlist:add-tracks ------------------------------------------------

export const playlistAddTracksInput = z.object({
  id: z.number().int().nonnegative(),
  tracks: z.array(trackRefSchema).readonly(),
}) satisfies z.ZodType<PlaylistAddTracksInput>;

export const playlistAddTracksOutput = z.object({
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
}) satisfies z.ZodType<PlaylistAddTracksOutput>;

// --- playlist:remove-tracks ---------------------------------------------

export const playlistRemoveTracksInput = z.object({
  id: z.number().int().nonnegative(),
  playlistTrackIds: z.array(z.number().int().nonnegative()).readonly(),
}) satisfies z.ZodType<PlaylistRemoveTracksInput>;

export const playlistRemoveTracksOutput = z.object({
  removed: z.number().int().nonnegative(),
}) satisfies z.ZodType<PlaylistRemoveTracksOutput>;

// --- playlist:reorder ---------------------------------------------------

export const playlistReorderInput = z.object({
  id: z.number().int().nonnegative(),
  orderedPlaylistTrackIds: z
    .array(z.number().int().nonnegative())
    .readonly(),
}) satisfies z.ZodType<PlaylistReorderInput>;
