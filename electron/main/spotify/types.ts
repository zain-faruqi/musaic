/**
 * Spotify Web API response shapes used by the auth module.
 *
 * Kept local to electron/main/spotify/ — these are wire-format types,
 * not shared with the renderer (renderer talks to main via IPC; main
 * is the only place that talks to Spotify directly).
 *
 * The types describe what we *use* from each response, not what
 * Spotify documents in full. If a future caller needs more fields,
 * extend here.
 */

/**
 * POST https://accounts.spotify.com/api/token
 *
 * Sent for both the initial authorization-code exchange and refresh-
 * token grants. Spotify always returns `access_token`, `expires_in`,
 * `scope`, and `token_type`. `refresh_token` is always returned on the
 * code exchange but is *optional* on refresh — Spotify only rotates it
 * sometimes, and when they don't, the caller must keep using the prior
 * one.
 */
export type SpotifyTokenResponse = {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
  readonly scope: string;
  readonly refresh_token?: string;
};

/**
 * GET https://api.spotify.com/v1/me
 *
 * We only consume `email` (to show the connected account on the
 * Connections row). Spotify returns more fields; we ignore them.
 */
export type SpotifyMeResponse = {
  readonly email: string;
};
