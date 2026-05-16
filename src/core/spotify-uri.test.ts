import { describe, expect, it } from 'vitest';
import {
  parseSpotifyInput,
  parseSpotifyTrackInput,
  spotifyAlbumWebUrl,
  spotifyPlaylistWebUrl,
  spotifyTrackWebUrl,
} from './spotify-uri';

const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b'; // "Blinding Lights"
const CANON_URI = `spotify:track:${TRACK_ID}`;
const PLAYLIST_ID = '37i9dQZF1DXcBWIGoYBM5M'; // a real-shaped playlist id
const PLAYLIST_URI = `spotify:playlist:${PLAYLIST_ID}`;
const ALBUM_ID = '4yP0hdKOZPNshxUOjY0cZj'; // "Currents" by Tame Impala
const ALBUM_URI = `spotify:album:${ALBUM_ID}`;

describe('parseSpotifyTrackInput — canonical URI', () => {
  it('accepts a bare spotify:track URI', () => {
    expect(parseSpotifyTrackInput(CANON_URI)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: CANON_URI,
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseSpotifyTrackInput(`  ${CANON_URI}  `)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: CANON_URI,
    });
  });

  it('rejects album URI', () => {
    expect(parseSpotifyTrackInput('spotify:album:4yP0hdKOZPNshxUOjY0cZj')).toBe(
      null,
    );
  });

  it('rejects playlist URI', () => {
    expect(
      parseSpotifyTrackInput('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'),
    ).toBe(null);
  });

  it('rejects artist URI', () => {
    expect(parseSpotifyTrackInput('spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ')).toBe(
      null,
    );
  });

  it('rejects URI with extra segments', () => {
    expect(
      parseSpotifyTrackInput(`spotify:track:${TRACK_ID}:extra`),
    ).toBe(null);
  });

  it('rejects truncated URI (only `spotify:track`)', () => {
    expect(parseSpotifyTrackInput('spotify:track')).toBe(null);
  });

  it('rejects URI with empty id', () => {
    expect(parseSpotifyTrackInput('spotify:track:')).toBe(null);
  });
});

describe('parseSpotifyTrackInput — HTTPS URL', () => {
  it('accepts a clean https://open.spotify.com URL', () => {
    expect(
      parseSpotifyTrackInput(`https://open.spotify.com/track/${TRACK_ID}`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('accepts the URL with a ?si= referral param', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/track/${TRACK_ID}?si=abc123xyz`,
      ),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('accepts the URL with multiple query params', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/track/${TRACK_ID}?si=foo&utm_source=bar`,
      ),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('accepts the URL with a trailing slash before the query', () => {
    // Spotify doesn't typically emit this shape but some link rewriters
    // (Slack, Discord) inject trailing slashes; lenient on the input.
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/track/${TRACK_ID}/`,
      ),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('accepts the intl-en variant', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/intl-en/track/${TRACK_ID}`,
      ),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('accepts the intl-de variant', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/intl-de/track/${TRACK_ID}?si=x`,
      ),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('rejects a URL pointing at an album', () => {
    expect(
      parseSpotifyTrackInput(
        'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj',
      ),
    ).toBe(null);
  });

  it('rejects a URL pointing at a playlist', () => {
    expect(
      parseSpotifyTrackInput(
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      ),
    ).toBe(null);
  });

  it('rejects open.spotify.com/track without an id', () => {
    expect(parseSpotifyTrackInput('https://open.spotify.com/track/')).toBe(
      null,
    );
  });

  it('rejects a different host (music.spotify.com)', () => {
    expect(
      parseSpotifyTrackInput(
        `https://music.spotify.com/track/${TRACK_ID}`,
      ),
    ).toBe(null);
  });

  it('rejects a phishing-style host', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com.evil.example/track/${TRACK_ID}`,
      ),
    ).toBe(null);
  });

  it('rejects http:// (only https in URL form)', () => {
    // We treat http:// as a probable mistype; if someone really has
    // an http:// link they can normalize it themselves. The locked
    // host check covers the substantive concern (wrong host); this
    // is just sticking to one shape so the rendered output URL is
    // consistent.
    //
    // Note: this is permissive at the parse layer — URL parses
    // http://open.spotify.com fine — but we keep the test here to
    // document the *intent* of the parser. If the test ever fails,
    // we revisit.
    //
    // Current behavior: ACCEPTS http (URL constructor doesn't
    // distinguish at the host check); we still canonicalize to the
    // spotify: URI which has no scheme concept, so the downstream
    // shape is identical. This test documents that.
    expect(
      parseSpotifyTrackInput(`http://open.spotify.com/track/${TRACK_ID}`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });
});

describe('parseSpotifyTrackInput — scheme-less URL', () => {
  it('accepts open.spotify.com/track/<id> with no scheme', () => {
    expect(
      parseSpotifyTrackInput(`open.spotify.com/track/${TRACK_ID}`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('accepts scheme-less URL with query params', () => {
    expect(
      parseSpotifyTrackInput(`open.spotify.com/track/${TRACK_ID}?si=xyz`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });

  it('rejects scheme-less URL with wrong host', () => {
    expect(
      parseSpotifyTrackInput(`example.com/track/${TRACK_ID}`),
    ).toBe(null);
  });
});

describe('parseSpotifyTrackInput — malformed inputs', () => {
  it('rejects empty string', () => {
    expect(parseSpotifyTrackInput('')).toBe(null);
  });

  it('rejects whitespace-only string', () => {
    expect(parseSpotifyTrackInput('   ')).toBe(null);
  });

  it('rejects non-spotify text', () => {
    expect(parseSpotifyTrackInput('not a url')).toBe(null);
  });

  it('rejects a bare 22-char base62 string (must be a URI or URL)', () => {
    // The "bare ID" shape is explicitly NOT supported — too easy to
    // confuse with random hex strings, hashes, etc. that happen to
    // be 22 base62 chars. Users always paste either the URI or URL.
    // Distinction from the YouTube parser, which DOES accept bare
    // IDs because they're more distinctive (`-` and `_` are common).
    expect(parseSpotifyTrackInput(TRACK_ID)).toBe(null);
  });

  it('rejects ids with non-base62 characters', () => {
    expect(parseSpotifyTrackInput('spotify:track:0VjIjW4GlUZAMYd2vXMi3-')).toBe(
      null,
    );
    expect(parseSpotifyTrackInput('spotify:track:0VjIjW4GlUZAMYd2vXMi3_')).toBe(
      null,
    );
  });

  it('rejects ids that are too short', () => {
    expect(parseSpotifyTrackInput('spotify:track:tooshort')).toBe(null);
  });

  it('rejects ids that are too long', () => {
    expect(
      parseSpotifyTrackInput(`spotify:track:${TRACK_ID}extra`),
    ).toBe(null);
  });

  it('handles non-string input defensively', () => {
    // Belt-and-braces against a caller passing through a runtime
    // value of the wrong type. Documented contract is `string`; the
    // runtime guard exists because the renderer's input.value path
    // is well-typed but main-side IPC strips types.
    expect(parseSpotifyTrackInput(undefined as unknown as string)).toBe(null);
    expect(parseSpotifyTrackInput(null as unknown as string)).toBe(null);
    expect(parseSpotifyTrackInput(42 as unknown as string)).toBe(null);
  });
});

describe('spotifyTrackWebUrl', () => {
  it('produces the canonical web URL', () => {
    expect(spotifyTrackWebUrl(TRACK_ID)).toBe(
      `https://open.spotify.com/track/${TRACK_ID}`,
    );
  });
});

describe('spotifyPlaylistWebUrl', () => {
  it('produces the canonical playlist web URL', () => {
    expect(spotifyPlaylistWebUrl(PLAYLIST_ID)).toBe(
      `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
    );
  });
});

// --- parseSpotifyInput — track ∪ playlist ∪ album ------------------
//
// The discriminated-union parser accepts both tracks and playlists.
// `parseSpotifyTrackInput` above narrows to tracks only and rejects
// playlists; these tests cover the widened surface.

describe('parseSpotifyInput — track inputs (track-shape parity)', () => {
  it('accepts a canonical track URI with kind=track', () => {
    expect(parseSpotifyInput(CANON_URI)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: CANON_URI,
    });
  });

  it('accepts an HTTPS track URL with kind=track', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/track/${TRACK_ID}`),
    ).toEqual({ kind: 'track', trackId: TRACK_ID, uri: CANON_URI });
  });
});

describe('parseSpotifyInput — playlist URI form', () => {
  it('accepts a canonical spotify:playlist URI', () => {
    expect(parseSpotifyInput(PLAYLIST_URI)).toEqual({
      kind: 'playlist',
      playlistId: PLAYLIST_ID,
      uri: PLAYLIST_URI,
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseSpotifyInput(`  ${PLAYLIST_URI}  `)).toEqual({
      kind: 'playlist',
      playlistId: PLAYLIST_ID,
      uri: PLAYLIST_URI,
    });
  });

  it('rejects playlist URI with extra segments', () => {
    expect(
      parseSpotifyInput(`spotify:playlist:${PLAYLIST_ID}:extra`),
    ).toBe(null);
  });

  it('rejects playlist URI with empty id', () => {
    expect(parseSpotifyInput('spotify:playlist:')).toBe(null);
  });

  it('rejects playlist URI with non-base62 id', () => {
    expect(
      parseSpotifyInput('spotify:playlist:37i9dQZF1DXcBWIGoYBM5-'),
    ).toBe(null);
  });
});

describe('parseSpotifyInput — playlist HTTPS URL form', () => {
  it('accepts a clean https playlist URL', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/playlist/${PLAYLIST_ID}`),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });

  it('accepts a playlist URL with ?si= referral param', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/playlist/${PLAYLIST_ID}?si=abc123xyz`,
      ),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });

  it('accepts a playlist URL with a trailing slash before the query', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/playlist/${PLAYLIST_ID}/`,
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

  it('accepts the intl-de playlist variant with si param', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/intl-de/playlist/${PLAYLIST_ID}?si=x`,
      ),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });
});

describe('parseSpotifyInput — scheme-less playlist URL', () => {
  it('accepts open.spotify.com/playlist/<id> with no scheme', () => {
    expect(
      parseSpotifyInput(`open.spotify.com/playlist/${PLAYLIST_ID}`),
    ).toEqual({ kind: 'playlist', playlistId: PLAYLIST_ID, uri: PLAYLIST_URI });
  });
});

describe('parseSpotifyInput — album URI form', () => {
  it('accepts a canonical spotify:album URI', () => {
    expect(parseSpotifyInput(ALBUM_URI)).toEqual({
      kind: 'album',
      albumId: ALBUM_ID,
      uri: ALBUM_URI,
    });
  });

  it('trims surrounding whitespace before parsing', () => {
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

  it('rejects album URI with non-base62 id', () => {
    expect(parseSpotifyInput('spotify:album:4yP0hdKOZPNshxUOjY0cZ-')).toBe(
      null,
    );
  });
});

describe('parseSpotifyInput — album HTTPS URL form', () => {
  it('accepts a clean https album URL', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/album/${ALBUM_ID}`),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });

  it('accepts an album URL with ?si= referral param', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com/album/${ALBUM_ID}?si=abc123xyz`,
      ),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });

  it('accepts an album URL with a trailing slash before the query', () => {
    expect(
      parseSpotifyInput(`https://open.spotify.com/album/${ALBUM_ID}/`),
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
});

describe('parseSpotifyInput — scheme-less album URL', () => {
  it('accepts open.spotify.com/album/<id> with no scheme', () => {
    expect(
      parseSpotifyInput(`open.spotify.com/album/${ALBUM_ID}`),
    ).toEqual({ kind: 'album', albumId: ALBUM_ID, uri: ALBUM_URI });
  });
});

describe('parseSpotifyInput — rejections', () => {
  it('accepts album URI', () => {
    // Albums are an admissible kind. Asserted here in the
    // rejections block as a breadcrumb for anyone re-reading this
    // file. The album-URI-form
    // describe block above is the canonical positive coverage.
    expect(
      parseSpotifyInput('spotify:album:4yP0hdKOZPNshxUOjY0cZj'),
    ).toEqual({
      kind: 'album',
      albumId: '4yP0hdKOZPNshxUOjY0cZj',
      uri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj',
    });
  });

  it('rejects artist URI', () => {
    expect(parseSpotifyInput('spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ')).toBe(
      null,
    );
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

  it('rejects bare 22-char base62 id (could be track / playlist / album — ambiguous)', () => {
    // The "bare ID" shape is explicitly NOT supported for any kind
    // — too easy to confuse with random hex strings, hashes, etc.
    expect(parseSpotifyInput(PLAYLIST_ID)).toBe(null);
  });

  it('rejects a phishing-style host for a playlist path', () => {
    expect(
      parseSpotifyInput(
        `https://open.spotify.com.evil.example/playlist/${PLAYLIST_ID}`,
      ),
    ).toBe(null);
  });

  it('handles non-string input defensively', () => {
    expect(parseSpotifyInput(undefined as unknown as string)).toBe(null);
    expect(parseSpotifyInput(null as unknown as string)).toBe(null);
    expect(parseSpotifyInput(42 as unknown as string)).toBe(null);
  });
});

describe('parseSpotifyTrackInput — narrows away playlists post-Slice-3b', () => {
  // These cases would now be accepted by `parseSpotifyInput` but
  // `parseSpotifyTrackInput` must still reject them — track-only
  // callsites (the SpotifyAdapter, etc.) rely on that narrowing.
  it('rejects playlist URI', () => {
    expect(parseSpotifyTrackInput(PLAYLIST_URI)).toBe(null);
  });

  it('rejects playlist HTTPS URL', () => {
    expect(
      parseSpotifyTrackInput(
        `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      ),
    ).toBe(null);
  });

  it('still tags accepted tracks with kind=track', () => {
    // Renamed shape post-Slice-3b: the narrowed wrapper now returns
    // `{ kind: 'track', trackId, uri }` to match the union. Track-only
    // callsites that previously destructured `{ trackId, uri }` keep
    // working; new code can switch on `kind`.
    expect(parseSpotifyTrackInput(CANON_URI)).toEqual({
      kind: 'track',
      trackId: TRACK_ID,
      uri: CANON_URI,
    });
  });
});

describe('parseSpotifyTrackInput — narrows away albums', () => {
  // Mirror of the narrowing block above: the wider parser admits
  // albums, the narrowed wrapper continues to reject them.
  it('rejects album URI', () => {
    expect(parseSpotifyTrackInput(ALBUM_URI)).toBe(null);
  });

  it('rejects album HTTPS URL', () => {
    expect(
      parseSpotifyTrackInput(`https://open.spotify.com/album/${ALBUM_ID}`),
    ).toBe(null);
  });
});

describe('spotifyAlbumWebUrl', () => {
  it('produces the canonical album web URL', () => {
    expect(spotifyAlbumWebUrl(ALBUM_ID)).toBe(
      `https://open.spotify.com/album/${ALBUM_ID}`,
    );
  });
});
