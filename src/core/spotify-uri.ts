/**
 * Parse a user-supplied Spotify input into a canonical form.
 *
 * Lives in `src/core/` rather than `src/adapters/spotify/` because
 * both processes need it: main consumes paste-and-save input on
 * `spotify:save`; the renderer's URL input validates locally before
 * IPC. Cross-process pattern matches `src/core/file-types.ts`.
 *
 * Accepts three flavors of input — tracks, playlists, and albums —
 * and returns a discriminated union keyed on `kind`:
 *
 *   { kind: 'track';    trackId;    uri }  for spotify:track:<id>
 *   { kind: 'playlist'; playlistId; uri }  for spotify:playlist:<id>
 *   { kind: 'album';    albumId;    uri }  for spotify:album:<id>
 *
 * Accepted input shapes (all three flavors):
 *
 *   1. Canonical URI:  spotify:{track,playlist,album}:<22b62>
 *   2. HTTPS URL:      https://open.spotify.com/{track,playlist,album}/<22b62>[?si=…]
 *   3. Scheme-less:    open.spotify.com/{track,playlist,album}/<22b62>
 *
 * Locale-of-the-URL paths (`/intl-en/track/…`, `/intl-de/album/…`)
 * also accepted — the spotify web player sometimes injects these.
 * The `intl-*` segment is consumed before the `/{type}/<id>` match.
 *
 * Rejected: bare 22-char IDs (collision risk), artists, users,
 * episodes, podcasts (shows). Anything else returns null. Callers
 * translate null into UI-visible "invalid input" rather than throwing.
 *
 * Tracks, playlists, and albums are all admissible kinds. The
 * historical `parseSpotifyTrackInput` name is retained as a narrowed
 * convenience wrapper for callers that only want tracks. Albums use
 * the same paste-and-import path as playlists.
 */

/**
 * Spotify track and playlist IDs are 22 characters from base62
 * (`[A-Za-z0-9]`, no `_` or `-`). Documented and stable for over a
 * decade.
 */
const ID_REGEX = /^[A-Za-z0-9]{22}$/;

export type ParsedSpotifyTrack = {
  readonly kind: 'track';
  readonly trackId: string;
  readonly uri: string;
};

export type ParsedSpotifyPlaylist = {
  readonly kind: 'playlist';
  readonly playlistId: string;
  readonly uri: string;
};

export type ParsedSpotifyAlbum = {
  readonly kind: 'album';
  readonly albumId: string;
  readonly uri: string;
};

export type ParsedSpotifyInput =
  | ParsedSpotifyTrack
  | ParsedSpotifyPlaylist
  | ParsedSpotifyAlbum;

const isValidId = (s: string): boolean => ID_REGEX.test(s);

const toTrack = (trackId: string): ParsedSpotifyTrack => ({
  kind: 'track',
  trackId,
  uri: `spotify:track:${trackId}`,
});

const toPlaylist = (playlistId: string): ParsedSpotifyPlaylist => ({
  kind: 'playlist',
  playlistId,
  uri: `spotify:playlist:${playlistId}`,
});

const toAlbum = (albumId: string): ParsedSpotifyAlbum => ({
  kind: 'album',
  albumId,
  uri: `spotify:album:${albumId}`,
});

/**
 * Try the canonical-URI form. Spotify URIs are `spotify:<type>:<id>`;
 * we accept `track`, `playlist`, and `album`. Anything else (artist,
 * episode, show, …) is rejected.
 */
const tryUri = (input: string): ParsedSpotifyInput | null => {
  if (!input.startsWith('spotify:')) return null;
  // Split on `:` and pick the type / id. Anything beyond three
  // segments — `spotify:track:<id>:<garbage>` — is rejected; we
  // don't try to be lenient on truncation either way.
  const parts = input.split(':');
  if (parts.length !== 3) return null;
  const type = parts[1];
  const id = parts[2];
  if (id === undefined || !isValidId(id)) return null;
  if (type === 'track') return toTrack(id);
  if (type === 'playlist') return toPlaylist(id);
  if (type === 'album') return toAlbum(id);
  return null;
};

/**
 * Try the URL forms (https and scheme-less). open.spotify.com is the
 * only accepted host; subdomains, music.spotify.com, etc. are
 * rejected so a renderer-side typo never accidentally matches the
 * wrong service.
 */
const tryUrl = (input: string): ParsedSpotifyInput | null => {
  // URL constructor needs a scheme. The scheme-less case (open.spotify.com/…)
  // wouldn't parse without one; prefix when absent. The check is on
  // the leading host (case-insensitive); other shapes fall through to
  // the parse below and fail naturally.
  let candidate = input;
  if (
    !candidate.startsWith('http://') &&
    !candidate.startsWith('https://')
  ) {
    if (!/^open\.spotify\.com\//i.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // Host check. Spotify's track / playlist / album URLs are served from
  // open.spotify.com. The hostname comparison is lowercase already
  // (URL normalizes).
  if (url.hostname !== 'open.spotify.com') return null;

  // Path: `/{track,playlist,album}/<id>`, possibly preceded by an
  // `/intl-<lang>/` prefix. Anything else (artist, the homepage,
  // search) is rejected.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);

  // Drop the optional intl-* prefix segment.
  if (segments.length > 0 && segments[0]?.startsWith('intl-')) {
    segments.shift();
  }

  if (segments.length !== 2) return null;
  const type = segments[0];
  const id = segments[1];
  if (id === undefined || !isValidId(id)) return null;
  if (type === 'track') return toTrack(id);
  if (type === 'playlist') return toPlaylist(id);
  if (type === 'album') return toAlbum(id);
  return null;
};

/**
 * Parse a Spotify input (track or playlist). See module docs for
 * accepted shapes and rejection rules.
 *
 * Returns null for unrecognized input — albums, artists, malformed
 * strings, wrong host, bare IDs, etc. Callers translate null into a
 * UI-visible "invalid input" rather than throwing; this function is
 * pure and total.
 */
export const parseSpotifyInput = (
  input: string,
): ParsedSpotifyInput | null => {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  return tryUri(trimmed) ?? tryUrl(trimmed);
};

/**
 * Track-only convenience wrapper. Narrows the union to the track
 * variant; returns null for playlist inputs as well as for the
 * shapes `parseSpotifyInput` already rejects.
 *
 * Retained because some callers (the SpotifyAdapter, the original
 * track-only callsites pre-Slice-3b) genuinely only want tracks —
 * this narrows in one line. The renderer-side input preflight check
 * uses `parseSpotifyInput` instead so playlist URIs validate locally
 * before IPC.
 */
export const parseSpotifyTrackInput = (
  input: string,
): ParsedSpotifyTrack | null => {
  const parsed = parseSpotifyInput(input);
  if (parsed === null) return null;
  if (parsed.kind !== 'track') return null;
  return parsed;
};

/**
 * Build the public web URL for a track. Used by the spotify adapter's
 * error class (open-on-spotify affordance) and by the system:open-
 * external allowlist. Single helper so the URL format only lives in
 * one place.
 */
export const spotifyTrackWebUrl = (trackId: string): string =>
  `https://open.spotify.com/track/${trackId}`;

/**
 * Build the public web URL for a playlist. Symmetric with
 * `spotifyTrackWebUrl`; not consumed yet (the app imports playlist
 * tracks but doesn't link to playlists from the UI), but the helper
 * lives next to its track sibling so a future "open on Spotify"
 * affordance for playlists has a canonical builder.
 */
export const spotifyPlaylistWebUrl = (playlistId: string): string =>
  `https://open.spotify.com/playlist/${playlistId}`;

/**
 * Build the public web URL for an album. Symmetric with
 * `spotifyTrackWebUrl` / `spotifyPlaylistWebUrl`. Albums (like
 * playlists) aren't an entity in the app — pasting an album URL
 * imports its tracks — so this isn't consumed by any "open on
 * Spotify" affordance today; the helper exists for parity and for a
 * future affordance to slot in cleanly.
 */
export const spotifyAlbumWebUrl = (albumId: string): string =>
  `https://open.spotify.com/album/${albumId}`;
