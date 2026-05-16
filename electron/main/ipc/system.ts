/**
 * System IPC handler.
 *
 * `system:open-external` — forward a URL to the OS's default browser
 *   via `shell.openExternal`. The renderer-supplied URL is validated
 *   against an allowlist in main before being shelled out: only
 *   YouTube watch URLs pass. This is a small but real attack surface —
 *   `shell.openExternal` will happily open `file://`, `javascript:`,
 *   custom-scheme handlers, etc. We don't want a renderer compromise
 *   (or a future feature that forwards untrusted strings through here)
 *   to turn this into an arbitrary-URL launcher.
 *
 * Today this only carries the click-time-unplayability "open on
 * youtube" affordance. New caller? New allowlist entry, deliberate.
 */
import { ipcMain, shell } from 'electron';
import {
  CHANNELS,
  systemOpenExternalInput,
} from '../../ipc/contracts';

/**
 * Pure URL allowlist check. Exported for testing.
 *
 * Accepted shapes:
 *   - `https://www.youtube.com/watch?v=…`
 *   - `https://youtube.com/watch?v=…`            (no www subdomain)
 *   - `https://youtu.be/…`
 *   - `https://open.spotify.com/track/<22b62>`
 *
 * Rejected:
 *   - any non-https scheme (`file:`, `javascript:`, custom schemes)
 *   - any host outside the listed surfaces
 *   - YouTube hosts at paths other than /watch (channels, search, etc.)
 *   - Spotify hosts at paths other than /track/<id> (album,
 *     playlist, artist — those aren't in our save flow)
 *   - Spotify URLs with non-base62 ids, ids of wrong length, intl-*
 *     prefixed paths (the click-time button always passes the
 *     canonical form built by `spotifyTrackWebUrl()` — anything else
 *     coming through here is suspicious)
 *   - malformed URLs that don't parse
 *
 * Returns true iff the URL passes. Pure: no side effects.
 */
const SPOTIFY_TRACK_PATH = /^\/track\/[A-Za-z0-9]{22}$/;

export function isOpenExternalUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (host === 'www.youtube.com' || host === 'youtube.com') {
    return parsed.pathname === '/watch';
  }
  if (host === 'youtu.be') {
    // youtu.be/<id> — accept any non-empty path. We don't try to
    // validate the videoId here; the platform handles malformed ones.
    return parsed.pathname.length > 1;
  }
  if (host === 'open.spotify.com') {
    // Strict path match against the canonical /track/<id> shape.
    // We don't admit /intl-*/track/<id> here — the renderer always
    // builds the URL via `spotifyTrackWebUrl()`, which produces the
    // canonical shape. Tightening the regex here means a future
    // bug that lets a different path through here is caught at the
    // boundary rather than in Spotify's web app.
    return SPOTIFY_TRACK_PATH.test(parsed.pathname);
  }
  return false;
}

export function registerSystemHandlers(): void {
  ipcMain.handle(
    CHANNELS.systemOpenExternal,
    async (_event, payload: unknown): Promise<void> => {
      const { url } = systemOpenExternalInput.parse(payload);
      if (!isOpenExternalUrlAllowed(url)) {
        // Source-prefixed for parity with adapter errors — easier to
        // spot in logs. Renderer surfaces this as a rejected promise.
        throw new Error(`system: openExternal blocked for url: ${url}`);
      }
      await shell.openExternal(url);
    },
  );
}
