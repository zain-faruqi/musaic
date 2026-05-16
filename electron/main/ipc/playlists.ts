/**
 * Playlist IPC handlers.
 *
 * Eight request/response channels and one push channel — same
 * shape as the library / spotify surfaces but for the
 * `playlists` + `playlist_tracks` tables.
 *
 *   - `playlist:create / :rename`     return a discriminated union
 *     (validation failure is a typed variant, not a rejected
 *     promise — matching the SpotifySave shape so the renderer can
 *     render inline messages without a try/catch).
 *   - `playlist:delete / :list / :get` return plain shapes.
 *   - `playlist:add-tracks`           returns `{ added, skipped }`
 *     (partial-success matters; tracks targeting refs not in the
 *     library are silently skipped at the db layer).
 *   - `playlist:remove-tracks`        returns `{ removed }`.
 *   - `playlist:reorder`              returns void.
 *
 * Every successful mutation broadcasts `playlist:changed` (signal-
 * only) so the renderer re-fetches via list / get. Mirrors the
 * library:changed and spotify:status-changed broadcast shapes.
 *
 * Error policy:
 *   * Zod parse failures on input → propagate as rejected promise.
 *     The bridge surface doesn't define an "invalid-input" variant
 *     for the playlist channels, and a malformed renderer call is
 *     a developer-visible bug, not a user UX state.
 *   * PlaylistValidationError on name → translate to the typed
 *     `{ kind: 'invalid-name', reason }` variant for create/rename.
 *   * Unknown id on rename/delete/get/add/remove/reorder → the
 *     underlying helper either returns null/false (delete, get)
 *     or throws (rename, addTracks, removeTracks, reorderTracks).
 *     We don't translate thrown unknown-id errors to a typed
 *     variant — the renderer treats them as stale-view conditions
 *     and re-fetches.
 *
 * Tests use `vi.mock('electron', …)` to capture the registered
 * handlers and invoke them with payloads; see playlists.test.ts.
 */
import { BrowserWindow, ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  CHANNELS,
  playlistAddTracksInput,
  playlistAddTracksOutput,
  playlistCreateInput,
  playlistCreateOutput,
  playlistDeleteInput,
  playlistGetInput,
  playlistGetOutput,
  playlistListOutput,
  playlistRemoveTracksInput,
  playlistRemoveTracksOutput,
  playlistRenameInput,
  playlistRenameOutput,
  playlistReorderInput,
  type PlaylistAddTracksOutput,
  type PlaylistCreateOutput,
  type PlaylistDeleteOutput,
  type PlaylistGetOutput,
  type PlaylistListOutput,
  type PlaylistRemoveTracksOutput,
  type PlaylistRenameOutput,
  type PlaylistReorderOutput,
} from '../../ipc/contracts';
import {
  PlaylistValidationError,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  renamePlaylist,
} from '../db/playlists';
import {
  addTracks,
  removeTracks,
  reorderTracks,
} from '../db/playlist_tracks';

/**
 * The substantive per-channel handler logic, exported individually
 * so tests can drive them without standing up `ipcMain`.
 *
 * Each is async to match the IPC handler signature (ipcMain.handle's
 * callback can return Promise<T> | T; we await throughout for
 * uniform shape). Payload comes in as `unknown`, gets Zod-parsed at
 * the top, then runs against the injected db.
 *
 * Mutating handlers take a `broadcast` callback rather than reaching
 * for BrowserWindow themselves — this lets the tests provide a
 * spyable function and lets the registration site keep the
 * BrowserWindow walk in one place. Mirrors how
 * `registerYouTubeHandlers(db, broadcast)` and
 * `registerSpotifyHandlers(db, broadcast)` thread their broadcaster.
 */

export async function handlePlaylistCreate(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistCreateOutput> {
  const { name } = playlistCreateInput.parse(payload);
  try {
    const playlist = createPlaylist(db, name);
    return playlistCreateOutput.parse({ kind: 'created', playlist });
  } catch (err) {
    if (err instanceof PlaylistValidationError) {
      return playlistCreateOutput.parse({
        kind: 'invalid-name',
        reason: err.reason,
      });
    }
    throw err;
  }
}

export async function handlePlaylistRename(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistRenameOutput> {
  const { id, name } = playlistRenameInput.parse(payload);
  try {
    const playlist = renamePlaylist(db, id, name);
    return playlistRenameOutput.parse({ kind: 'renamed', playlist });
  } catch (err) {
    if (err instanceof PlaylistValidationError) {
      return playlistRenameOutput.parse({
        kind: 'invalid-name',
        reason: err.reason,
      });
    }
    // Unknown-id errors from renamePlaylist propagate as rejected
    // promise; the renderer treats that as a stale-view condition.
    throw err;
  }
}

export async function handlePlaylistDelete(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistDeleteOutput> {
  const { id } = playlistDeleteInput.parse(payload);
  // Idempotent: deleting an unknown id returns false from the db
  // helper. Don't translate that into a rejection — the renderer
  // calls delete on stale ids during navigation races and should
  // treat both outcomes the same (the playlist is gone).
  deletePlaylist(db, id);
}

export async function handlePlaylistList(
  db: DatabaseSync,
): Promise<PlaylistListOutput> {
  // listPlaylists returns the wire shape directly — no row-to-wire
  // conversion needed.
  return playlistListOutput.parse(listPlaylists(db));
}

export async function handlePlaylistGet(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistGetOutput> {
  const { id } = playlistGetInput.parse(payload);
  return playlistGetOutput.parse(getPlaylist(db, id));
}

export async function handlePlaylistAddTracks(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistAddTracksOutput> {
  const { id, tracks } = playlistAddTracksInput.parse(payload);
  // addTracks throws on unknown playlist id; propagate as rejection.
  // Skipped refs (FK target absent) are surfaced inside the result,
  // not as throws.
  const result = addTracks(db, id, tracks);
  return playlistAddTracksOutput.parse(result);
}

export async function handlePlaylistRemoveTracks(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistRemoveTracksOutput> {
  const { id, playlistTrackIds } = playlistRemoveTracksInput.parse(payload);
  const result = removeTracks(db, id, playlistTrackIds);
  return playlistRemoveTracksOutput.parse(result);
}

export async function handlePlaylistReorder(
  db: DatabaseSync,
  payload: unknown,
): Promise<PlaylistReorderOutput> {
  const { id, orderedPlaylistTrackIds } = playlistReorderInput.parse(payload);
  reorderTracks(db, id, orderedPlaylistTrackIds);
}

/**
 * Result-aware broadcast helper: returns whether the result of a
 * create/rename was a real mutation (broadcast worth firing) or a
 * validation-failure variant (no state change to signal).
 */
function isMutatingCreateResult(r: PlaylistCreateOutput): boolean {
  return r.kind === 'created';
}
function isMutatingRenameResult(r: PlaylistRenameOutput): boolean {
  return r.kind === 'renamed';
}

/**
 * Register all eight playlist IPC handlers, plus the
 * `playlist:changed` broadcast hook.
 *
 * The broadcast walks every BrowserWindow and sends signal-only —
 * same shape as `broadcastLibraryChanged` in electron/main/index.ts.
 * Threaded through as a parameter so tests can swap a spy in.
 */
export function registerPlaylistHandlers(
  db: DatabaseSync,
  broadcastPlaylistChanged: () => void,
): void {
  ipcMain.handle(CHANNELS.playlistCreate, async (_event, payload: unknown) => {
    const result = await handlePlaylistCreate(db, payload);
    if (isMutatingCreateResult(result)) broadcastPlaylistChanged();
    return result;
  });

  ipcMain.handle(CHANNELS.playlistRename, async (_event, payload: unknown) => {
    const result = await handlePlaylistRename(db, payload);
    if (isMutatingRenameResult(result)) broadcastPlaylistChanged();
    return result;
  });

  ipcMain.handle(CHANNELS.playlistDelete, async (_event, payload: unknown) => {
    await handlePlaylistDelete(db, payload);
    // Delete is idempotent — always broadcast, even when the row
    // wasn't there. The renderer may be looking at a stale list;
    // a re-fetch confirms the gone state regardless.
    broadcastPlaylistChanged();
  });

  ipcMain.handle(CHANNELS.playlistList, async () => handlePlaylistList(db));

  ipcMain.handle(CHANNELS.playlistGet, async (_event, payload: unknown) =>
    handlePlaylistGet(db, payload),
  );

  ipcMain.handle(
    CHANNELS.playlistAddTracks,
    async (_event, payload: unknown) => {
      const result = await handlePlaylistAddTracks(db, payload);
      // Broadcast only when at least one row was added — otherwise
      // we'd cause a no-op re-fetch (e.g. caller asked to add zero
      // tracks, or all targets were missing from the library).
      if (result.added > 0) broadcastPlaylistChanged();
      return result;
    },
  );

  ipcMain.handle(
    CHANNELS.playlistRemoveTracks,
    async (_event, payload: unknown) => {
      const result = await handlePlaylistRemoveTracks(db, payload);
      if (result.removed > 0) broadcastPlaylistChanged();
      return result;
    },
  );

  ipcMain.handle(
    CHANNELS.playlistReorder,
    async (_event, payload: unknown) => {
      await handlePlaylistReorder(db, payload);
      broadcastPlaylistChanged();
    },
  );
}

/**
 * Build a broadcaster for `playlist:changed`. Walks every live
 * BrowserWindow and sends signal-only. Mirrors the
 * `broadcastLibraryChanged` helper in electron/main/index.ts —
 * exported separately rather than inline at the call site so the
 * shape is unit-testable and the call site keeps the explicit
 * registration order.
 */
export function makeBroadcastPlaylistChanged(): () => void {
  return (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.playlistChanged);
      }
    }
  };
}
