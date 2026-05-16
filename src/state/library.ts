import {
  libraryImportOutput,
  libraryListOutput,
  spotifySaveOutput,
  youtubeSaveOutput,
  type LibraryImportOutput,
  type LibraryTrack,
  type SpotifySaveOutput,
  type TrackRef,
  type YouTubeSaveOutput,
} from '@ipc/contracts';
import type { UnifiedTrack } from '@renderer/core/types';
import { usePlayerStore } from './player-store';

/**
 * Convert the over-the-wire LibraryTrack shape to the renderer's
 * UnifiedTrack. The wire shape uses `T | undefined` on optionals
 * (Zod's `.optional()` inference); UnifiedTrack uses `T?`, which
 * under exactOptionalPropertyTypes is a strictly different type.
 * Spread-omit on undefined values bridges the two.
 *
 * Exported because the playlist detail page reuses it to convert
 * `PlaylistMembership.track` (LibraryTrack) values into the
 * UnifiedTrack shape `setQueue` expects. Same conversion, two call
 * sites — no separate helper module needed.
 */
export const toUnifiedTrack = (parsed: LibraryTrack): UnifiedTrack => ({
  id: parsed.id,
  source: parsed.source,
  sourceId: parsed.sourceId,
  title: parsed.title,
  artists: parsed.artists,
  durationMs: parsed.durationMs,
  ...(parsed.album !== undefined && { album: parsed.album }),
  ...(parsed.artwork !== undefined && { artwork: parsed.artwork }),
  ...(parsed.isrc !== undefined && { isrc: parsed.isrc }),
});

/**
 * Renderer-side IPC wrapper. Validates the response via Zod before
 * returning — defense-in-depth at the IPC boundary. Treats
 * every main response as `unknown` until parsed.
 */
const importFile = async (): Promise<UnifiedTrack | null> => {
  const raw = await window.musaic.library.importFile();
  const parsed: LibraryImportOutput = libraryImportOutput.parse(raw);
  if (parsed === null) return null;
  return toUnifiedTrack(parsed);
};

/**
 * Fetch every indexed track from main (local + youtube etc., mixed).
 * The list is already sorted by `created_at DESC` at the SQL layer —
 * see electron/main/db/tracks.ts (getAllTracks). The renderer does
 * not re-sort; preserving the contract here means a future re-order
 * change needs one file edit, not two.
 */
export const listLibrary = async (): Promise<readonly UnifiedTrack[]> => {
  const raw = await window.musaic.library.list();
  const parsed = libraryListOutput.parse(raw);
  return parsed.map(toUnifiedTrack);
};

/**
 * Show the file picker, copy the chosen file into the Musaic folder,
 * index it, and dispatch setQueue with a single-track queue. The
 * "open file" pill on HomePage still uses this; it's the documented
 * fallback for adding a one-off file outside the watched folder.
 *
 * After import, the watcher's `add` event will also see the new file
 * inside the Musaic folder and fire `library:changed`; the renderer's
 * library store picks that up and re-fetches. The two paths converge
 * on the same row (upsert; `created_at` preserved on conflict).
 */
export const pickAndPlay = async (): Promise<void> => {
  const track = await importFile();
  if (!track) return;
  usePlayerStore.getState().actions.setQueue([track]);
};

/**
 * Discriminated result of a YouTube paste-and-save, after Zod parse
 * and (in the saved/embed-restricted branches) the wire→UnifiedTrack
 * conversion. Renderer components consume this shape, not the raw
 * wire one.
 *
 * The `'saved'` variant carries `refs` (single-element array of
 * `(source, sourceId)`) so the picker's paste-to-add path can
 * compute auto-select. `'embed-restricted'` deliberately omits
 * refs — the picker's callback fires only for fully-successful
 * saves; auto-selecting an unplayable track into a playlist would
 * be a footgun.
 */
export type SaveYouTubeResult =
  | {
      readonly kind: 'saved';
      readonly track: UnifiedTrack;
      readonly refs: readonly TrackRef[];
    }
  | { readonly kind: 'embed-restricted'; readonly track: UnifiedTrack }
  | { readonly kind: 'not-found' };

/**
 * Paste-and-save a YouTube URL. Returns a discriminated result so the
 * caller (YouTubeUrlInput) can render different inline states for
 * each outcome.
 *
 * Errors from the underlying IPC (network failure, malformed URL,
 * unexpected oEmbed shape) propagate as a rejected promise — the
 * caller surfaces them with a generic "save failed" message rather
 * than treating them as one of the three documented outcomes.
 */
export const saveYouTube = async (url: string): Promise<SaveYouTubeResult> => {
  const raw = await window.musaic.youtube.save({ url });
  const parsed: YouTubeSaveOutput = youtubeSaveOutput.parse(raw);
  switch (parsed.kind) {
    case 'saved':
      return {
        kind: 'saved',
        track: toUnifiedTrack(parsed.track),
        refs: parsed.refs,
      };
    case 'embed-restricted':
      return { kind: 'embed-restricted', track: toUnifiedTrack(parsed.track) };
    case 'not-found':
      return { kind: 'not-found' };
  }
};

/**
 * Discriminated result of a Spotify paste-and-save / paste-and-import.
 * Mirrors `SaveYouTubeResult` in shape: the `'saved'` variant carries
 * the converted UnifiedTrack; the rest are reason-only.
 *
 *   - 'saved'           — track-input full success; row upserted.
 *                         Library picks it up on the next
 *                         library:changed broadcast. `refs` is a
 *                         single-element array keying the persisted
 *                         row.
 *   - 'imported'        — playlist-input full success; tracks
 *                         upserted (the renderer already received
 *                         them via per-page library:changed
 *                         broadcasts). Totals carry through to the
 *                         input component for inline messaging.
 *                         `imported` = playable count persisted;
 *                         `skipped` = tombstoned + is_local items;
 *                         `truncated` = playlist exceeded the
 *                         10,000-track import cap. `refs`
 *                         is the full list of refs for the import's
 *                         input set — including conflict-skipped
 *                         already-in-library refs (the picker still
 *                         auto-selects them).
 *   - 'auth-required'   — no stored token, or token refresh failed.
 *                         SpotifyUrlInput points the user at the
 *                         Connections row.
 *   - 'invalid-input'   — input wasn't a parseable track-or-playlist
 *                         URI/URL. Treated as a local validation
 *                         failure; input is preserved so the user
 *                         can fix it.
 *   - 'not-found'       — Web API returned 404 for the parsed
 *                         trackId / playlistId. Same UX as YouTube's
 *                         'not-found'.
 *   - 'network-error'   — fetch failed, 429 after retry, or schema
 *                         mismatch. User can retry.
 */
export type SaveSpotifyResult =
  | {
      readonly kind: 'saved';
      readonly track: UnifiedTrack;
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

/**
 * Paste-and-save / paste-and-import a Spotify URI or URL. Returns
 * a discriminated result; `SpotifyUrlInput` maps each variant to
 * inline UX.
 *
 * The `'imported'` variant carries totals but no track payload —
 * imported tracks arrive via per-page `library:changed` broadcasts
 * (one per ≤100-track Spotify-API page) which the library store is
 * already subscribed to. The renderer just renders the running
 * library; the totals here drive the input pill's inline summary.
 *
 * Errors from the underlying IPC (auth module crash, an
 * unanticipated Spotify Web API response shape, etc.) propagate as a
 * rejected promise rather than collapsing to one of the categorized
 * variants — same convention as `saveYouTube`.
 */
export const saveSpotify = async (
  input: string,
): Promise<SaveSpotifyResult> => {
  const raw = await window.musaic.spotify.save({ input });
  const parsed: SpotifySaveOutput = spotifySaveOutput.parse(raw);
  switch (parsed.kind) {
    case 'saved':
      return {
        kind: 'saved',
        track: toUnifiedTrack(parsed.track),
        refs: parsed.refs,
      };
    case 'imported':
      // No UnifiedTrack conversion: imported tracks ride the
      // library:changed channel, not this response.
      return {
        kind: 'imported',
        imported: parsed.imported,
        skipped: parsed.skipped,
        truncated: parsed.truncated,
        refs: parsed.refs,
      };
    case 'auth-required':
      return { kind: 'auth-required' };
    case 'invalid-input':
      return { kind: 'invalid-input' };
    case 'not-found':
      return { kind: 'not-found' };
    case 'network-error':
      return { kind: 'network-error' };
  }
};
