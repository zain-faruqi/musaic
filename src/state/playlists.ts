/**
 * Renderer-side IPC wrappers for the eight `playlist:*` channels.
 *
 * Same shape as `src/state/library.ts`: each wrapper invokes the
 * bridge method, parses the response via Zod (defense-in-depth
 * at the IPC boundary), and returns the typed result.
 * The store consumes these; UI consumes the store.
 *
 * Naming convention: each function name reads as the verb
 * (`createPlaylist`, `renamePlaylist`, `listPlaylists`, etc.).
 * Matches the db helpers; the renderer's mental model is "call
 * the operation," not "invoke a channel."
 */
import {
  playlistAddTracksOutput,
  playlistCreateOutput,
  playlistGetOutput,
  playlistListOutput,
  playlistRemoveTracksOutput,
  playlistRenameOutput,
  type PlaylistAddTracksInput,
  type PlaylistAddTracksOutput,
  type PlaylistCreateOutput,
  type PlaylistDetail,
  type PlaylistMembership,
  type PlaylistRenameOutput,
  type PlaylistRemoveTracksOutput,
  type PlaylistReorderInput,
  type PlaylistSummary,
} from '@ipc/contracts';
import type { UnifiedTrack } from '@renderer/core/types';

export const createPlaylist = async (
  name: string,
): Promise<PlaylistCreateOutput> => {
  const raw = await window.musaic.playlist.create({ name });
  return playlistCreateOutput.parse(raw);
};

export const renamePlaylist = async (
  id: number,
  name: string,
): Promise<PlaylistRenameOutput> => {
  const raw = await window.musaic.playlist.rename({ id, name });
  return playlistRenameOutput.parse(raw);
};

export const deletePlaylist = async (id: number): Promise<void> => {
  // Delete returns void; no Zod parse needed (nothing to validate).
  await window.musaic.playlist.delete({ id });
};

export const listPlaylists = async (): Promise<readonly PlaylistSummary[]> => {
  const raw = await window.musaic.playlist.list();
  return playlistListOutput.parse(raw);
};

export const getPlaylist = async (
  id: number,
): Promise<PlaylistDetail | null> => {
  const raw = await window.musaic.playlist.get({ id });
  return playlistGetOutput.parse(raw);
};

export const addTracksToPlaylist = async (
  input: PlaylistAddTracksInput,
): Promise<PlaylistAddTracksOutput> => {
  const raw = await window.musaic.playlist.addTracks(input);
  return playlistAddTracksOutput.parse(raw);
};

export const removeTracksFromPlaylist = async (
  id: number,
  playlistTrackIds: readonly number[],
): Promise<PlaylistRemoveTracksOutput> => {
  const raw = await window.musaic.playlist.removeTracks({
    id,
    playlistTrackIds,
  });
  return playlistRemoveTracksOutput.parse(raw);
};

export const reorderPlaylist = async (
  input: PlaylistReorderInput,
): Promise<void> => {
  await window.musaic.playlist.reorder(input);
};

// --- pure helpers -------------------------------------------------------

/**
 * Build the picker view's `availableTracks` list: every library track
 * whose `(source, sourceId)` pair is NOT already a member of the given
 * playlist.
 *
 * Why filter here rather than render-disable: the picker's job is to
 * grow the playlist; showing already-added tracks is visual noise for
 * a personal app where most playlists hold a small fraction of the
 * library.
 *
 * Implementation: a Set keyed `${source}:${sourceId}` for O(N+M)
 * filtering. Pure function — no IPC, no store reads — so it's a
 * one-line unit test rather than something that needs renderer-side
 * setup.
 */
export const computeAvailableTracks = (
  libraryTracks: readonly UnifiedTrack[],
  membership: readonly PlaylistMembership[],
): readonly UnifiedTrack[] => {
  const present = new Set<string>();
  for (const m of membership) {
    present.add(`${m.track.source}:${m.track.sourceId}`);
  }
  return libraryTracks.filter(
    (t) => !present.has(`${t.source}:${t.sourceId}`),
  );
};

/**
 * Compose the inline-message text that surfaces under the URL pills
 * in the Add Tracks picker after a paste resolves.
 *
 * Two counters drive the text:
 *
 *   - `addedToSelection` — how many paste-returned refs the picker
 *     newly toggled ON in its selection set this paste. Includes both
 *     freshly-fetched tracks and already-in-library refs that weren't
 *     already selected. A ref already in the user's selection prior
 *     to this paste is a no-op and is NOT counted here (per spec, no-
 *     ops aren't surfaced).
 *   - `alreadyInPlaylist` — how many paste-returned refs target
 *     tracks that are already members of the current playlist. Those
 *     refs are filtered out of `availableTracks` (4b decision) and
 *     can't be selected, so this counter is the only way they
 *     surface to the user.
 *
 * Cases:
 *   - (0, 0)  → null  (nothing actionable; no message)
 *   - (N, 0)  → "Added N to selection."
 *   - (0, M)  → "M already in this playlist."
 *   - (N, M)  → "Added N to selection. M already in this playlist."
 *
 * Pure function — easy to unit-test, no React, no DOM. The picker
 * component owns the timer + render; this just shapes the string.
 */
export const composeInlineMessage = (
  addedToSelection: number,
  alreadyInPlaylist: number,
): string | null => {
  const parts: string[] = [];
  if (addedToSelection > 0) {
    parts.push(`Added ${addedToSelection} to selection.`);
  }
  if (alreadyInPlaylist > 0) {
    parts.push(`${alreadyInPlaylist} already in this playlist.`);
  }
  // Empty parts cover both the spec'd (0, 0) no-op case AND the
  // defensive negative-input case — callers shouldn't pass negatives,
  // but if a bug in the reconciliation effect ever did, the user
  // sees nothing rather than "Added -1 to selection."
  if (parts.length === 0) return null;
  return parts.join(' ');
};
