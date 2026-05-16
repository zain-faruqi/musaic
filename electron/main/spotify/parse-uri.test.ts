/**
 * Tests for the main-side Spotify input parser. Mirrors the renderer
 * suite in `src/core/spotify-uri.test.ts` — the two parsers are
 * duplicate-by-design and must stay in sync. This file covers the
 * The track ∪ playlist discriminated union behavior.
 *
 * Why parallel suites: the main-side copy can't import from src/ and
 * the renderer copy can't import from electron/main/, so a shared
 * test file isn't an option. Both suites cover the same input shapes
 * so divergence between the parsers surfaces in CI.
 */
import { describe, expect, it } from 'vitest';
import {
  parseSpotifyInput,
  parseSpotifyTrackInput,
  spotifyAlbumWebUrl,
  spotifyPlaylistWebUrl,
  spotifyTrackWebUrl,
} from './parse-uri';

const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';
const TRACK_URI = `spotify:track:${TRACK_ID}`;
const PLAYLIST_ID = '37i9dQZF1DXcBWIGoYBM5M';
const PLAYLIST_URI = `spotify:playlist:${PLAYLIST_ID}`;
const ALBUM_ID = '4yP0hdKOZPNshxUOjY0cZj';
const ALBUM_URI = `spotify:album:${ALBUM_ID}`;

describe('parseSpotifyInput — track URI form', () => {
  it('accepts a canonical track URI', () => {
    expect(parseSpotifyInput(TRACK_URI)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: TRACK_URI,
    });
  });

  it('trims whitespace before parsing', () => {
    expect(parseSpotifyInput(`  ${TRACK_URI}  `)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: TRACK_URI,
    });
  });

  it('rejects track URI with extra segments', () => {
    expect(parseSpotifyInput(`${TRACK_URI}:extra`)).toBe(null);
  });

  it('rejects track URI with empty id', () => {
    expect(parseSpotifyInput('spotify:track:')).toBe(null);
  });

  it('rejects non-base62 track id', () => {
    expect(parseSpotifyInput('spotify:track:0VjIjW4GlUZAMYd2vXMi3-')).toBe(
      null,
    );
  });
});

describe('parseSpotifyInput — track URL form', () => {
  it('accepts a clean https track URL', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/track/${TRACK_ID}`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: TRACK_URI });
  });

  it('accepts the intl-en track variant', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/intl-en/track/${TRACK_ID}?si=x`,
      ),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: TRACK_URI });
  });

  it('accepts scheme-less track URL', () => {
    expect(
      parseSpotifyInput(`open.spotify.com/track/${TRACK_ID}`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: TRACK_URI });
  });
});

describe('parseSpotifyInput — playlist URI form', () => {
  it('accepts a canonical playlist URI', () => {
    expect(parseSpotifyInput(PLAYLIST_URI)).toEqual({
      kind: 'playlist',
      playlistId: PLAYLIST_ID,
      uri: PLAYLIST_URI,
    });
  });

  it('trims whitespace', () => {
    expect(parseSpotifyInput(`  ${PLAYLIST_URI}  `)).toEqual({
      kind: 'playlist',
      playlistId: PLAYLIST_ID,
      uri: PLAYLIST_URI,
    });
  });

  it('rejects playlist URI with extra segments', () => {
    expect(parseSpotifyInput(`${PLAYLIST_URI}:extra`)).toBe(null);
  });

  it('rejects playlist URI with empty id', () => {
    expect(parseSpotifyInput('spotify:playlist:')).toBe(null);
  });
});

describe('parseSpotifyInput — playlist URL form', () => {
  it('accepts a clean https playlist URL', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/playlist/${PLAYLIST_ID}`),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });

  it('accepts a playlist URL with ?si= param', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/playlist/${PLAYLIST_ID}?si=abc`,
      ),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });

  it('accepts the intl-en playlist variant', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/intl-en/playlist/${PLAYLIST_ID}`,
      ),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });

  it('accepts the intl-de playlist variant', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/intl-de/playlist/${PLAYLIST_ID}?si=x`,
      ),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });

  it('accepts scheme-less playlist URL', () => {
    expect(
      parseSpotifyInput(`open.spotify.com/playlist/${PLAYLIST_ID}`),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });
});

describe('parseSpotifyInput — album URI form', () => {
  it('accepts a canonical album URI', () => {
    expect(parseSpotifyInput(ALBUM_URI)).toEqual({
      kind: 'album',
      albumId: ALBUM_ID,
      uri: ALBUM_URI,
    });
  });

  it('trims whitespace', () => {
    expect(parseSpotifyInput(`  ${ALBUM_URI}  `)).toEqual({
      kind: 'album',
      albumId: ALBUM_ID,
      uri: ALBUM_URI,
    });
  });

  it('rejects album URI with extra segments', () => {
    expect(parseSpotifyInput(`${ALBUM_URI}:extra`)).toBe(null);
  });

  it('rejects album URI with empty id', () => {
    expect(parseSpotifyInput('spotify:album:')).toBe(null);
  });

  it('rejects non-base62 album id', () => {
    expect(parseSpotifyInput('spotify:album:4yP0hdKOZPNshxUOjY0cZ-')).toBe(
      null,
    );
  });
});

describe('parseSpotifyInput — album URL form', () => {
  it('accepts a clean https album URL', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/album/${ALBUM_ID}`),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });

  it('accepts an album URL with ?si= param', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/album/${ALBUM_ID}?si=abc`,
      ),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });

  it('accepts the intl-en album variant', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/intl-en/album/${ALBUM_ID}`,
      ),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });

  it('accepts the intl-de album variant with si param', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/intl-de/album/${ALBUM_ID}?si=x`,
      ),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });

  it('accepts scheme-less album URL', () => {
    expect(
      parseSpotifyInput(`open.spotify.com/album/${ALBUM_ID}`),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });
});

describe('parseSpotifyInput — rejections', () => {
  it('accepts album URI', () => {
    // Albums are an admissible kind alongside tracks and playlists.
    // Asserted in the rejections block as a regression breadcrumb
    // — anyone re-reading this file expecting the pre-5a behavior
    // sees the flip explicitly. The album-URI-form describe above is
    // the canonical positive coverage.
    expect(parseSpotifyInput('spotify:album:4yP0hdKOZPNshxUOjY0cZj')).toEqual({
      kind: 'album',
      albumId: '4yP0hdKOZPNshxUOjY0cZj',
      uri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj',
    });
  });

  it('rejects artist URI', () => {
    expect(
      parseSpotifyInput('spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ'),
    ).toBe(null);
  });

  it('rejects episode URI', () => {
    expect(
      parseSpotifyInput('spotify:episode:0VjIjW4GlUZAMYd2vXMi3b'),
    ).toBe(null);
  });

  it('accepts album HTTPS URL', () => {
    expect(
      parseSpotifyInput(
        'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj',
      ),
    ).toEqual({
      kind: 'album',
      albumId: '4yP0hdKOZPNshxUOjY0cZj',
      uri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj',
    });
  });

  it('rejects bare 22-char base62 id', () => {
    // No "is it a track or a playlist" disambiguation possible.
    expect(parseSpotifyInput(TRACK_ID)).toBe(null);
    expect(parseSpotifyInput(PLAYLIST_ID)).toBe(null);
  });

  it('rejects empty / whitespace / non-string inputs', () => {
    expect(parseSpotifyInput('')).toBe(null);
    expect(parseSpotifyInput('   ')).toBe(null);
    expect(parseSpotifyInput(undefined as unknown as string)).toBe(null);
    expect(parseSpotifyInput(null as unknown as string)).toBe(null);
    expect(parseSpotifyInput(42 as unknown as string)).toBe(null);
  });

  it('rejects a different host', () => {
    expect(
      parseSpotifyInput(`https://music.spotify.com/track/${TRACK_ID}`),
    ).toBe(null);
  });

  it('rejects a phishing-style host', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com.evil.example/playlist/${PLAYLIST_ID}`,
      ),
    ).toBe(null);
  });
});

describe('parseSpotifyTrackInput — narrowed wrapper', () => {
  it('accepts a track URI', () => {
    expect(parseSpotifyTrackInput(TRACK_URI)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: TRACK_URI,
    });
  });

  it('rejects a playlist URI even though parseSpotifyInput accepts it', () => {
    // Sanity check: the wider parser would have accepted this.
    expect(parseSpotifyInput(PLAYLIST_URI)).not.toBe(null);
    // But the narrowed wrapper rejects.
    expect(parseSpotifyTrackInput(PLAYLIST_URI)).toBe(null);
  });

  it('rejects a playlist HTTPS URL', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      ),
    ).toBe(null);
  });

  it('rejects an album URI even though parseSpotifyInput accepts it', () => {
    // The wider parser admits albums; the track-only narrowed wrapper
    // must continue to reject them. Track-only callsites (the
    // SpotifyAdapter etc.) rely on this.
    expect(parseSpotifyInput(ALBUM_URI)).not.toBe(null);
    expect(parseSpotifyTrackInput(ALBUM_URI)).toBe(null);
  });

  it('rejects an album HTTPS URL', () => {
    expect(
      parseSpotifyTrackInput(`https://open.spotify.com/album/${ALBUM_ID}`),
    ).toBe(null);
  });
});

describe('spotifyTrackWebUrl / spotifyPlaylistWebUrl / spotifyAlbumWebUrl', () => {
  it('builds the canonical track web URL', () => {
    expect(spotifyTrackWebUrl(TRACK_ID)).toBe(
      `https://open.spotify.com/track/${TRACK_ID}`,
    );
  });

  it('builds the canonical playlist web URL', () => {
    expect(spotifyPlaylistWebUrl(PLAYLIST_ID)).toBe(
      `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
    );
  });

  it('builds the canonical album web URL', () => {
    expect(spotifyAlbumWebUrl(ALBUM_ID)).toBe(
      `https://open.spotify.com/album/${ALBUM_ID}`,
    );
  });
});
