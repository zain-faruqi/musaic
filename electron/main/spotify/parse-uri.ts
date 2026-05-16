/**
 * Parse a user-supplied Spotify input into a canonical form.
 *
 * Duplicated from `src/core/spotify-uri.ts` because electron/ (main)
 * and src/ (renderer) are bundled by separate tsconfigs and can't
 * cross-import. Same convention as `electron/main/youtube/parse-video-id.ts`
 * vs `src/adapters/youtube/parse-video-id.ts`. Pure utility; both
 * copies must stay in sync.
 *
 * Accepts tracks, playlists, and albums as a discriminated union
 * `{ kind: 'track' | 'playlist' | 'album'; … }`. The historical
 * `parseSpotifyTrackInput` narrowed wrapper is retained for callers
 * that only want tracks. Albums dispatch to the same paste-and-import
 * path as playlists; their shape mirrors `ParsedSpotifyPlaylist`
 * (`albumId` + `uri`).
 *
 * If this drifts from the renderer copy: both halves have parallel
 * test suites covering the same input shapes, so divergence would
 * surface. The implementation is small enough that re-syncing is a
 * one-pass edit.
 *
 * See the renderer copy for the accepted-shapes rationale.
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

const tryUri = (input: string): ParsedSpotifyInput | null => {
  if (!input.startsWith('spotify:')) return null;
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

const tryUrl = (input: string): ParsedSpotifyInput | null => {
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

  if (url.hostname !== 'open.spotify.com') return null;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
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

export const parseSpotifyInput = (
  input: string,
): ParsedSpotifyInput | null => {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  return tryUri(trimmed) ?? tryUrl(trimmed);
};

/**
 * Track-only convenience wrapper. Narrows to `kind: 'track'`; returns
 * null for playlist inputs and everything else `parseSpotifyInput`
 * rejects.
 */
export const parseSpotifyTrackInput = (
  input: string,
): ParsedSpotifyTrack | null => {
  const parsed = parseSpotifyInput(input);
  if (parsed === null) return null;
  if (parsed.kind !== 'track') return null;
  return parsed;
};

export const spotifyTrackWebUrl = (trackId: string): string =>
  `https://open.spotify.com/track/${trackId}`;

export const spotifyPlaylistWebUrl = (playlistId: string): string =>
  `https://open.spotify.com/playlist/${playlistId}`;

export const spotifyAlbumWebUrl = (albumId: string): string =>
  `https://open.spotify.com/album/${albumId}`;
