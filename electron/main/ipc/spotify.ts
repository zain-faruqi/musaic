/**
 * Spotify IPC handlers.
 *
 * Four request/response channels:
 *   - `spotify:connect`     — kicks off the OAuth flow.
 *   - `spotify:disconnect`  — clears stored tokens.
 *   - `spotify:status`      — read-only connection state.
 *   - `spotify:get-token`   — fresh access token (refreshes if needed).
 *
 * Plus one push channel:
 *   - `spotify:status-changed` — signal-only main→renderer broadcast.
 *
 * The handlers are thin: they validate payloads at the IPC boundary,
 * call into `auth.ts`, validate outbound responses against the same
 * schemas, and translate thrown errors into the SpotifyStatus error
 * variant for the request/response channels. Real work lives in
 * `auth.ts`.
 *
 * Error policy: errors from `auth.connect()` (network failure, /me
 * lookup failure, token-endpoint rejection, port-in-use) translate
 * to `{ kind: 'error', message }` rather than rejecting the IPC.
 * The renderer then renders the error under the Connect button. The
 * other three channels handle errors differently — see comments below.
 */
import { BrowserWindow, ipcMain, shell } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import {
  CHANNELS,
  spotifySaveInput,
  spotifySaveOutput,
  spotifyStatus,
  spotifyTokenResult,
  type SpotifySaveOutput,
  type SpotifyStatus,
  type SpotifyTokenResult,
} from '../../ipc/contracts';
import {
  connect,
  disconnect,
  getAccessToken,
  getStatus,
  onStatusChanged,
} from '../spotify/auth';
import { parseSpotifyInput } from '../spotify/parse-uri';
import {
  importSpotifyAlbum,
  importSpotifyPlaylist,
  saveSpotifyTrack,
} from '../spotify/save';

/**
 * Default browser opener — wraps `shell.openExternal` so `auth.connect()`
 * can be unit-tested with a stub. We don't allowlist the URL here
 * because the only caller passes an URL we constructed from a literal
 * (https://accounts.spotify.com/authorize); any future caller that
 * accepts a renderer-supplied URL would need its own allowlist (see
 * the locked `system:open-external` pattern).
 */
const openSpotifyAuthorizeUrl = async (url: string): Promise<void> => {
  await shell.openExternal(url);
};

/**
 * Translate an auth-module thrown error into a SpotifyStatus error
 * variant. Used by `spotify:connect`. Keeps the renderer's IPC
 * promise resolved (not rejected) so the connect button can render
 * an error message without a try/catch wrapper.
 */
function toErrorStatus(err: unknown): SpotifyStatus {
  const message = err instanceof Error ? err.message : 'unknown error';
  return { kind: 'error', message };
}

/**
 * Wire up the Spotify IPC handlers AND the push-channel broadcast.
 *
 * The push-channel broadcast is set up by subscribing to
 * `auth.onStatusChanged` here (rather than inside the auth module
 * itself) — auth doesn't depend on BrowserWindow. Mirrors how
 * `library:changed` is broadcast from electron/main/index.ts.
 *
 * `db` and `broadcastLibraryChanged` are required because the
 * `spotify:save` handler needs both. They thread through the same
 * way as `registerYouTubeHandlers(db, broadcast)`.
 */
export function registerSpotifyHandlers(
  db: DatabaseSync,
  broadcastLibraryChanged: () => void,
): void {
  ipcMain.handle(
    CHANNELS.spotifyConnect,
    async (): Promise<SpotifyStatus> => {
      try {
        const result = await connect(openSpotifyAuthorizeUrl);
        // Self-validate outbound: same rationale as library:list /
        // youtube:save — catch drift before it crosses the wire.
        return spotifyStatus.parse(result);
      } catch (err) {
        // Translate any thrown error into a SpotifyStatus.error variant.
        // The renderer then renders the message under the Connect button.
        const status = toErrorStatus(err);
        return spotifyStatus.parse(status);
      }
    },
  );

  ipcMain.handle(
    CHANNELS.spotifyDisconnect,
    async (): Promise<void> => {
      // Disconnect is best-effort and shouldn't fail — but if it does,
      // re-throw rather than swallow. The renderer treats a rejected
      // promise as a developer-visible bug; the user shouldn't see
      // "disconnect succeeded" if tokens remained on disk.
      await disconnect();
    },
  );

  ipcMain.handle(
    CHANNELS.spotifyStatus,
    async (): Promise<SpotifyStatus> => {
      // Status reads can fail at the /me-lookup step on cold launch
      // (revoked tokens, network hiccup). The auth module already
      // handles those by clearing and returning disconnected; only a
      // truly unexpected throw would land here. Wrap defensively
      // anyway — same shape as connect.
      try {
        return spotifyStatus.parse(await getStatus());
      } catch (err) {
        return spotifyStatus.parse(toErrorStatus(err));
      }
    },
  );

  ipcMain.handle(
    CHANNELS.spotifyGetToken,
    async (): Promise<SpotifyTokenResult> => {
      const token = await getAccessToken();
      const result: SpotifyTokenResult =
        token === null
          ? { kind: 'not-connected' }
          : { kind: 'connected', accessToken: token };
      return spotifyTokenResult.parse(result);
    },
  );

  // `spotify:save` — paste-and-save / paste-and-import pipeline.
  // Parses the input once, dispatches on the discriminant kind.
  //
  //   - kind: 'track'    → saveSpotifyTrack; broadcast on success.
  //   - kind: 'playlist' → importSpotifyPlaylist; broadcast happens
  //                        per page inside the import (see save.ts),
  //                        not here. We don't broadcast again at the
  //                        end: every persisted page already
  //                        triggered one, so a final broadcast would
  //                        be a wasted re-fetch.
  //   - kind: 'album'    → importSpotifyAlbum. Same
  //                        per-page broadcast semantics as playlist;
  //                        same `{ kind: 'imported', … }` response
  //                        shape. The discriminated outcome doesn't
  //                        carry playlist-vs-album identity — the
  //                        renderer's inline message is the same
  //                        "imported N tracks" copy either way.
  //
  // Errors not mapped to a SpotifySaveOutput variant propagate as a
  // rejected promise — the renderer's catch-all surfaces them
  // generically.
  ipcMain.handle(
    CHANNELS.spotifySave,
    async (_event, payload: unknown): Promise<SpotifySaveOutput> => {
      const { input } = spotifySaveInput.parse(payload);
      const parsed = parseSpotifyInput(input);
      if (parsed === null) {
        return spotifySaveOutput.parse({ kind: 'invalid-input' });
      }

      if (parsed.kind === 'track') {
        const result = await saveSpotifyTrack(parsed, {
          db,
          getToken: getAccessToken,
        });
        // Broadcast only when a row was persisted. The other
        // outcomes don't change the library; broadcasting would
        // trigger a wasted re-fetch.
        if (result.kind === 'saved') {
          broadcastLibraryChanged();
        }
        return spotifySaveOutput.parse(result);
      }

      if (parsed.kind === 'playlist') {
        const outcome = await importSpotifyPlaylist(parsed, {
          db,
          getToken: getAccessToken,
          broadcast: broadcastLibraryChanged,
        });
        if (outcome.kind === 'imported') {
          return spotifySaveOutput.parse({
            kind: 'imported',
            imported: outcome.result.imported,
            skipped: outcome.result.skipped,
            truncated: outcome.result.truncated,
            refs: outcome.result.refs,
          });
        }
        // 'auth-required' | 'not-found' | 'network-error' — the
        // payload-free variants line up exactly with SpotifySaveOutput
        // kinds, so the kind passes through unchanged.
        return spotifySaveOutput.parse({ kind: outcome.kind });
      }

      // parsed.kind === 'album'
      const outcome = await importSpotifyAlbum(parsed, {
        db,
        getToken: getAccessToken,
        broadcast: broadcastLibraryChanged,
      });
      if (outcome.kind === 'imported') {
        return spotifySaveOutput.parse({
          kind: 'imported',
          imported: outcome.result.imported,
          skipped: outcome.result.skipped,
          truncated: outcome.result.truncated,
          refs: outcome.result.refs,
        });
      }
      return spotifySaveOutput.parse({ kind: outcome.kind });
    },
  );

  // Wire the push channel. Same broadcast pattern as library:changed
  // in electron/main/index.ts: walk every BrowserWindow, send to the
  // ones whose webContents are still alive. Subscription happens
  // here so the auth module stays UI-independent.
  onStatusChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.spotifyStatusChanged);
      }
    }
  });
}
