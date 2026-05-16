/**
 * Tests for the Spotify Web API track-metadata client. Mocks the
 * fetch via FetchLike injection — same seam as the YouTube oembed
 * client.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchAlbumTracks,
  fetchPlaylistTracks,
  fetchTrackMetadata,
  SpotifyTrackError,
  type FetchLike,
} from './web-api';

const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';
const TOKEN = 'BQAfake-access-token';

/**
 * Construct a successful response body shaped like Spotify's
 * `GET /v1/tracks/{id}` documents. Helpers below override individual
 * fields for edge cases.
 */
const mockOk = (overrides: Record<string, unknown> = {}): FetchLike =>
  vi.fn(async () =>
    new Response(
      JSON.stringify({
        name: 'Blinding Lights',
        artists: [{ name: 'The Weeknd' }],
        album: {
          name: 'After Hours',
          images: [
            { url: 'https://i.scdn.co/image/640.jpg', height: 640, width: 640 },
            { url: 'https://i.scdn.co/image/300.jpg', height: 300, width: 300 },
            { url: 'https://i.scdn.co/image/64.jpg', height: 64, width: 64 },
          ],
        },
        duration_ms: 200040,
        external_ids: { isrc: 'USUG11904206' },
        ...overrides,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

const mockStatus = (status: number): FetchLike =>
  vi.fn(async () => new Response('', { status }));

describe('fetchTrackMetadata — happy path', () => {
  it('returns normalized metadata for a typical response', async () => {
    const result = await fetchTrackMetadata(TRACK_ID, TOKEN, mockOk());
    expect(result).toEqual({
      trackId: TRACK_ID,
      uri: `spotify:track:${TRACK_ID}`,
      title: 'Blinding Lights',
      artists: ['The Weeknd'],
      album: 'After Hours',
      durationMs: 200040,
      artworkUrl: 'https://i.scdn.co/image/300.jpg',
      isrc: 'USUG11904206',
    });
  });

  it('handles multi-artist tracks', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({
        artists: [
          { name: 'Travis Scott' },
          { name: 'Kid Cudi' },
        ],
      }),
    );
    expect(result.artists).toEqual(['Travis Scott', 'Kid Cudi']);
  });

  it('handles tracks without an ISRC', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({ external_ids: {} }),
    );
    expect(result.isrc).toBeUndefined();
  });

  it('handles tracks without external_ids at all', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({ external_ids: undefined }),
    );
    expect(result.isrc).toBeUndefined();
  });

  it('sends the access token as a Bearer header', async () => {
    const spy: FetchLike = vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'X',
          artists: [{ name: 'Y' }],
          album: { name: 'Z', images: [] },
          duration_ms: 1,
        }),
        { status: 200 },
      ),
    );
    await fetchTrackMetadata(TRACK_ID, TOKEN, spy);
    expect(spy).toHaveBeenCalledWith(
      `https://api.spotify.com/v1/tracks/${TRACK_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
        }),
      }),
    );
  });

  it('URL-encodes the trackId in the path', async () => {
    // Defense-in-depth — the caller's been through parseSpotifyTrackInput
    // so the ID is already known-good. This test pins the encoding so a
    // future change here doesn't silently let a `/`-bearing id through.
    const spy: FetchLike = vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'X',
          artists: [{ name: 'Y' }],
          album: { name: 'Z', images: [] },
          duration_ms: 1,
        }),
        { status: 200 },
      ),
    );
    await fetchTrackMetadata('weird/id', TOKEN, spy);
    expect(spy).toHaveBeenCalledWith(
      `https://api.spotify.com/v1/tracks/weird%2Fid`,
      expect.any(Object),
    );
  });
});

describe('fetchTrackMetadata — artwork selection', () => {
  it('prefers the 300-width image when available', async () => {
    const result = await fetchTrackMetadata(TRACK_ID, TOKEN, mockOk());
    expect(result.artworkUrl).toBe('https://i.scdn.co/image/300.jpg');
  });

  it('picks the closest-to-300 when 300 itself is absent', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({
        album: {
          name: 'X',
          images: [
            { url: 'https://i.scdn.co/640.jpg', height: 640, width: 640 },
            { url: 'https://i.scdn.co/250.jpg', height: 250, width: 250 },
            { url: 'https://i.scdn.co/64.jpg', height: 64, width: 64 },
          ],
        },
      }),
    );
    expect(result.artworkUrl).toBe('https://i.scdn.co/250.jpg');
  });

  it('skips images below 64px width', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({
        album: {
          name: 'X',
          images: [
            { url: 'https://i.scdn.co/16.jpg', height: 16, width: 16 },
            { url: 'https://i.scdn.co/640.jpg', height: 640, width: 640 },
          ],
        },
      }),
    );
    expect(result.artworkUrl).toBe('https://i.scdn.co/640.jpg');
  });

  it('falls back to middle-by-index when widths are unpopulated', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({
        album: {
          name: 'X',
          images: [
            { url: 'https://i.scdn.co/a.jpg' },
            { url: 'https://i.scdn.co/b.jpg' },
            { url: 'https://i.scdn.co/c.jpg' },
          ],
        },
      }),
    );
    expect(result.artworkUrl).toBe('https://i.scdn.co/b.jpg');
  });

  it('omits artworkUrl when images array is empty', async () => {
    const result = await fetchTrackMetadata(
      TRACK_ID,
      TOKEN,
      mockOk({
        album: { name: 'X', images: [] },
      }),
    );
    expect(result.artworkUrl).toBeUndefined();
  });
});

describe('fetchTrackMetadata — error mapping', () => {
  it('maps 404 to reason=not-found', async () => {
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, mockStatus(404)),
    ).rejects.toMatchObject({
      reason: 'not-found',
      trackId: TRACK_ID,
    });
  });

  it('maps 401 to reason=auth-required', async () => {
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, mockStatus(401)),
    ).rejects.toMatchObject({
      reason: 'auth-required',
      trackId: TRACK_ID,
    });
  });

  it('maps 429 to reason=rate-limited', async () => {
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, mockStatus(429)),
    ).rejects.toMatchObject({
      reason: 'rate-limited',
      trackId: TRACK_ID,
    });
  });

  it('maps 500 to reason=network', async () => {
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, mockStatus(500)),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: TRACK_ID,
    });
  });

  it('maps a fetch throw to reason=network', async () => {
    const broken: FetchLike = vi.fn(async () => {
      throw new TypeError('NetworkError');
    });
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, broken),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: TRACK_ID,
    });
  });

  it('maps malformed JSON to reason=network', async () => {
    const malformed: FetchLike = vi.fn(async () =>
      new Response('not json {{{', { status: 200 }),
    );
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, malformed),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: TRACK_ID,
    });
  });

  it('maps schema-mismatch to reason=network', async () => {
    const wrongShape: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ name: 'X' }), { status: 200 }),
    );
    await expect(
      fetchTrackMetadata(TRACK_ID, TOKEN, wrongShape),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: TRACK_ID,
    });
  });

  it('error class identity stays SpotifyTrackError', async () => {
    let captured: unknown = null;
    try {
      await fetchTrackMetadata(TRACK_ID, TOKEN, mockStatus(404));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SpotifyTrackError);
    expect((captured as Error).message).toMatch(/^spotify: track 0VjIjW/);
  });
});

// --- fetchPlaylistTracks ------------------------------------------------

const PLAYLIST_ID = '2NQjdk518rsx5awjyphz5E';

/** Build a single playlist-track item shaped like Spotify's response. */
const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  added_at: '2024-01-01T00:00:00Z',
  is_local: false,
  track: {
    id: 'aaaaaaaaaaaaaaaaaaaaaa',
    uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa',
    name: 'Track A',
    artists: [{ name: 'Artist' }],
    album: {
      name: 'Album',
      images: [
        { url: 'https://i.scdn.co/640.jpg', width: 640 },
        { url: 'https://i.scdn.co/300.jpg', width: 300 },
        { url: 'https://i.scdn.co/64.jpg', width: 64 },
      ],
    },
    duration_ms: 200000,
    is_local: false,
    external_ids: { isrc: 'AAAAA0000000' },
    ...((overrides.track as Record<string, unknown>) ?? {}),
  },
  ...Object.fromEntries(
    Object.entries(overrides).filter(([k]) => k !== 'track'),
  ),
});

/** Build a track item with a distinct id (for ordering / pagination tests). */
const itemId = (idChar: string): Record<string, unknown> => {
  const id = idChar.repeat(22);
  return item({
    track: {
      id,
      uri: `spotify:track:${id}`,
      name: `Track ${idChar}`,
      artists: [{ name: 'Artist' }],
      album: { name: 'Album', images: [] },
      duration_ms: 200000,
      is_local: false,
    },
  });
};

const pageResponse = (
  items: ReadonlyArray<Record<string, unknown>>,
  next: string | null,
): Response =>
  new Response(JSON.stringify({ next, items }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('fetchPlaylistTracks — happy path', () => {
  it('returns a single-page playlist with all tracks', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse([itemId('a'), itemId('b'), itemId('c')], null),
    );
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(3);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.tracks[0]?.trackId).toBe('a'.repeat(22));
    expect(result.tracks[2]?.trackId).toBe('c'.repeat(22));
  });

  it('passes the access token as a Bearer header', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse([itemId('a')], null),
    );
    await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
        }),
      }),
    );
  });

  it('requests market=from_token and limit=100', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse([itemId('a')], null),
    );
    await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    const url = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0];
    expect(url).toMatch(/limit=100/);
    expect(url).toMatch(/market=from_token/);
    expect(url).toMatch(/fields=/);
    // playlistId in the path
    expect(url).toMatch(new RegExp(`/playlists/${PLAYLIST_ID}/tracks`));
  });

  it('preserves order across multiple pages', async () => {
    // Two full pages of 100, then a partial page of 50 — 250 tracks
    // total. Use distinct ids per item so ordering is verifiable.
    const ids = Array.from({ length: 250 }, (_, i) =>
      // 22-char base62 ids; pad with leading zeros so they sort
      // lexically the same way as numerically.
      i.toString().padStart(22, '0'),
    );
    const mkItem = (id: string): Record<string, unknown> => ({
      added_at: '2024-01-01T00:00:00Z',
      is_local: false,
      track: {
        id,
        uri: `spotify:track:${id}`,
        name: `Track ${id}`,
        artists: [{ name: 'A' }],
        album: { name: 'Alb', images: [] },
        duration_ms: 1,
        is_local: false,
      },
    });

    const pages = [
      pageResponse(ids.slice(0, 100).map(mkItem), 'https://api.spotify.com/next-1'),
      pageResponse(ids.slice(100, 200).map(mkItem), 'https://api.spotify.com/next-2'),
      pageResponse(ids.slice(200, 250).map(mkItem), null),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });

    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(250);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.tracks[0]?.trackId).toBe(ids[0]);
    expect(result.tracks[99]?.trackId).toBe(ids[99]);
    expect(result.tracks[100]?.trackId).toBe(ids[100]);
    expect(result.tracks[249]?.trackId).toBe(ids[249]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('follows the next URL exactly as Spotify returns it', async () => {
    const nextUrl =
      'https://api.spotify.com/v1/playlists/x/tracks?offset=100&limit=100';
    const pages = [
      pageResponse([itemId('a')], nextUrl),
      pageResponse([itemId('b')], null),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });
    await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    // Second call uses the next URL verbatim — the offset/limit
    // params come from Spotify, not from a re-built URL.
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]?.[0],
    ).toBe(nextUrl);
  });

  it('invokes the per-page callback with playable tracks in page order', async () => {
    const pages = [
      pageResponse([itemId('a'), itemId('b')], 'https://api.spotify.com/next'),
      pageResponse([itemId('c')], null),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });
    const onPage = vi.fn();
    await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl, onPage);
    expect(onPage).toHaveBeenCalledTimes(2);
    // First call: page 0, two tracks.
    expect(onPage.mock.calls[0]?.[1]).toBe(0);
    expect(onPage.mock.calls[0]?.[0]).toHaveLength(2);
    // Second call: page 1, one track.
    expect(onPage.mock.calls[1]?.[1]).toBe(1);
    expect(onPage.mock.calls[1]?.[0]).toHaveLength(1);
  });
});

describe('fetchPlaylistTracks — filtering', () => {
  it('skips tombstoned items (track: null) and counts them', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse(
        [
          itemId('a'),
          { added_at: '2024-01-01', is_local: false, track: null },
          itemId('b'),
        ],
        null,
      ),
    );
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it('skips items with is_local=true on the wrapper', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse(
        [
          itemId('a'),
          { ...itemId('b'), is_local: true },
          itemId('c'),
        ],
        null,
      ),
    );
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it('skips items with is_local=true on the inner track', async () => {
    const localItem = item({
      track: {
        id: 'b'.repeat(22),
        uri: 'spotify:local:Album/Track.mp3',
        name: 'Local',
        artists: [{ name: 'A' }],
        album: { name: 'Local', images: [] },
        duration_ms: 1,
        is_local: true,
      },
    });
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse([itemId('a'), localItem, itemId('c')], null),
    );
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it('skips items whose track.id is null (defensive)', async () => {
    const noIdItem = item({
      track: {
        id: null,
        uri: 'spotify:local:something',
        name: 'X',
        artists: [{ name: 'A' }],
        album: { name: 'X', images: [] },
        duration_ms: 1,
        is_local: false,
      },
    });
    const fetchImpl: FetchLike = vi.fn(async () =>
      pageResponse([itemId('a'), noIdItem], null),
    );
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('threads skipped count across multiple pages', async () => {
    const pages = [
      pageResponse(
        [
          itemId('a'),
          { added_at: '2024-01-01', is_local: false, track: null },
        ],
        'https://api.spotify.com/next',
      ),
      pageResponse(
        [{ ...itemId('b'), is_local: true }, itemId('c')],
        null,
      ),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(2);
    expect(result.skipped).toBe(2);
  });
});

describe('fetchPlaylistTracks — error mapping', () => {
  it('maps 404 to reason=not-found', async () => {
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, mockStatus(404)),
    ).rejects.toMatchObject({
      reason: 'not-found',
      trackId: PLAYLIST_ID,
    });
  });

  it('maps 401 to reason=auth-required', async () => {
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, mockStatus(401)),
    ).rejects.toMatchObject({
      reason: 'auth-required',
      trackId: PLAYLIST_ID,
    });
  });

  it('maps 500 to reason=network', async () => {
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, mockStatus(500)),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: PLAYLIST_ID,
    });
  });

  it('maps fetch throw to reason=network', async () => {
    const broken: FetchLike = vi.fn(async () => {
      throw new TypeError('NetworkError');
    });
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, broken),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: PLAYLIST_ID,
    });
  });

  it('maps malformed page (missing items) to reason=network', async () => {
    const malformed: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ next: null }), { status: 200 }),
    );
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, malformed),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: PLAYLIST_ID,
    });
  });

  it('maps invalid JSON to reason=network', async () => {
    const invalidJson: FetchLike = vi.fn(async () =>
      new Response('not json {{{', { status: 200 }),
    );
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, invalidJson),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: PLAYLIST_ID,
    });
  });

  it('mentions the page number in the error message', async () => {
    // Page 0 fails — message should identify which page died.
    let captured: unknown = null;
    try {
      await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, mockStatus(500));
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toMatch(/page 0/);
  });

  it('mentions a non-zero page number when a later page fails', async () => {
    const pages: Response[] = [
      pageResponse([itemId('a')], 'https://api.spotify.com/next'),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p !== undefined) return p;
      return new Response('', { status: 500 });
    });
    let captured: unknown = null;
    try {
      await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toMatch(/page 1/);
  });
});

describe('fetchPlaylistTracks — 429 retry', () => {
  it('retries once after the Retry-After delay and succeeds', async () => {
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return pageResponse([itemId('a'), itemId('b')], null);
    });
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('collapses to rate-limited if the retry also returns 429', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      new Response('', {
        status: 429,
        headers: { 'Retry-After': '0' },
      }),
    );
    await expect(
      fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl),
    ).rejects.toMatchObject({
      reason: 'rate-limited',
      trackId: PLAYLIST_ID,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('handles missing Retry-After header (default delay)', async () => {
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('', { status: 429 });
      }
      return pageResponse([itemId('a')], null);
    });
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(1);
  });
});

describe('fetchPlaylistTracks — truncation', () => {
  it('returns truncated=true when 100 pages still have a next cursor', async () => {
    // Each page returns a single item and a non-null `next`. After
    // 100 pages we should bail and return truncated=true. Use a
    // fresh response per call (Response bodies can only be consumed
    // once).
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      return pageResponse(
        [itemId(String.fromCharCode(97 + (call % 26)))],
        'https://api.spotify.com/forever',
      );
    });
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.truncated).toBe(true);
    expect(result.tracks).toHaveLength(100);
    // Exactly 100 page fetches — the 101st is not issued.
    expect(fetchImpl).toHaveBeenCalledTimes(100);
  });

  it('does NOT mark truncated when the playlist exactly fills', async () => {
    // 100 pages, last one returns next: null. Should NOT be truncated.
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      const isLast = call === 100;
      return pageResponse(
        [itemId(String.fromCharCode(97 + (call % 26)))],
        isLast ? null : 'https://api.spotify.com/more',
      );
    });
    const result = await fetchPlaylistTracks(PLAYLIST_ID, TOKEN, fetchImpl);
    expect(result.truncated).toBe(false);
    expect(result.tracks).toHaveLength(100);
  });
});

// --- fetchAlbumTracks ----------------------------------------

const ALBUM_ID = '4yP0hdKOZPNshxUOjY0cZj';

/**
 * Build a single album-track item shaped like Spotify's
 * `GET /v1/albums/{id}` response. Note: unlike playlist items, the
 * track lives directly at the item level (no `track:` wrapper) and
 * there is no `is_local` field. The album name + artwork are NOT on
 * the item — they sit on the parent album response.
 */
const albumItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'aaaaaaaaaaaaaaaaaaaaaa',
  uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa',
  name: 'Track A',
  artists: [{ name: 'Tame Impala' }],
  duration_ms: 200000,
  is_playable: true,
  external_ids: { isrc: 'AAAAA0000000' },
  ...overrides,
});

/** Build an album item with a distinct id. */
const albumItemId = (idChar: string): Record<string, unknown> => {
  const id = idChar.repeat(22);
  return albumItem({
    id,
    uri: `spotify:track:${id}`,
    name: `Track ${idChar}`,
    artists: [{ name: 'Tame Impala' }],
    duration_ms: 200000,
  });
};

/**
 * Build the album bootstrap response. Embeds the first page of
 * tracks under `tracks` with its own `next` cursor.
 */
const albumBootstrap = (
  args: {
    readonly items: ReadonlyArray<Record<string, unknown>>;
    readonly next: string | null;
    readonly albumOverrides?: Record<string, unknown>;
  },
): Response =>
  new Response(
    JSON.stringify({
      id: ALBUM_ID,
      name: 'Currents',
      artists: [{ name: 'Tame Impala' }],
      images: [
        { url: 'https://i.scdn.co/album-640.jpg', width: 640 },
        { url: 'https://i.scdn.co/album-300.jpg', width: 300 },
        { url: 'https://i.scdn.co/album-64.jpg', width: 64 },
      ],
      tracks: { next: args.next, items: args.items },
      ...args.albumOverrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/**
 * Build an album-tracks paginated page response. Subsequent pages
 * (followed via `tracks.next`) return the flat `{next,items}` shape
 * directly — no album wrapper.
 */
const albumTracksPage = (
  items: ReadonlyArray<Record<string, unknown>>,
  next: string | null,
): Response =>
  new Response(JSON.stringify({ next, items }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('fetchAlbumTracks — happy path', () => {
  it('returns a single-page album with all tracks', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      albumBootstrap({
        items: [albumItemId('a'), albumItemId('b'), albumItemId('c')],
        next: null,
      }),
    );
    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(3);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.tracks[0]?.trackId).toBe('a'.repeat(22));
    expect(result.tracks[2]?.trackId).toBe('c'.repeat(22));
  });

  it('decorates each track with the parent album name and artwork', async () => {
    // Album-track items lack their own `album` and `images` — those
    // come from the bootstrap response and are baked into each
    // `SpotifyTrackMetadata`. Asymmetric with playlist items, which
    // carry album/images per-track.
    const fetchImpl: FetchLike = vi.fn(async () =>
      albumBootstrap({
        items: [albumItemId('a')],
        next: null,
      }),
    );
    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks[0]?.album).toBe('Currents');
    // Medium-image picker: targets width closest to 300; the
    // bootstrap above includes 640 / 300 / 64.
    expect(result.tracks[0]?.artworkUrl).toBe(
      'https://i.scdn.co/album-300.jpg',
    );
  });

  it('passes the access token as a Bearer header', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      albumBootstrap({ items: [albumItemId('a')], next: null }),
    );
    await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
        }),
      }),
    );
  });

  it('requests market=from_token in the bootstrap call', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      albumBootstrap({ items: [albumItemId('a')], next: null }),
    );
    await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    const url = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0];
    expect(url).toMatch(/market=from_token/);
    expect(url).toMatch(new RegExp(`/albums/${ALBUM_ID}`));
  });

  it('paginates across album-track pages via tracks.next', async () => {
    // Bootstrap returns page 0 with a non-null `next`; page 1 returns
    // the flat shape with `next: null`. Both pages contribute to the
    // final track list in order.
    const nextUrl = 'https://api.spotify.com/v1/albums/X/tracks?offset=50&limit=50';
    const pages = [
      albumBootstrap({
        items: [albumItemId('a'), albumItemId('b')],
        next: nextUrl,
      }),
      albumTracksPage([albumItemId('c'), albumItemId('d')], null),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });

    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(4);
    expect(result.tracks[0]?.trackId).toBe('a'.repeat(22));
    expect(result.tracks[1]?.trackId).toBe('b'.repeat(22));
    expect(result.tracks[2]?.trackId).toBe('c'.repeat(22));
    expect(result.tracks[3]?.trackId).toBe('d'.repeat(22));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('follows the tracks.next URL exactly as Spotify returns it', async () => {
    const nextUrl =
      'https://api.spotify.com/v1/albums/X/tracks?offset=50&limit=50';
    const pages = [
      albumBootstrap({ items: [albumItemId('a')], next: nextUrl }),
      albumTracksPage([albumItemId('b')], null),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });
    await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]?.[0],
    ).toBe(nextUrl);
  });

  it('invokes the per-page callback with the bootstrap page first', async () => {
    const nextUrl = 'https://api.spotify.com/v1/albums/X/tracks?offset=2';
    const pages = [
      albumBootstrap({
        items: [albumItemId('a'), albumItemId('b')],
        next: nextUrl,
      }),
      albumTracksPage([albumItemId('c')], null),
    ];
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      const p = pages[call];
      call += 1;
      if (p === undefined) throw new Error('unexpected extra call');
      return p;
    });
    const onPage = vi.fn();
    await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl, onPage);
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage.mock.calls[0]?.[1]).toBe(0);
    expect(onPage.mock.calls[0]?.[0]).toHaveLength(2);
    expect(onPage.mock.calls[1]?.[1]).toBe(1);
    expect(onPage.mock.calls[1]?.[0]).toHaveLength(1);
  });
});

describe('fetchAlbumTracks — filtering', () => {
  it('skips is_playable=false items (region-unplayable)', async () => {
    // Album catalog with mixed playability. `market=from_token`
    // makes Spotify return `is_playable: false` on tracks the
    // user's region can't stream. Counted as skipped, not an error.
    const fetchImpl: FetchLike = vi.fn(async () =>
      albumBootstrap({
        items: [
          albumItem({
            id: 'b'.repeat(22),
            uri: `spotify:track:${'b'.repeat(22)}`,
            name: 'Playable',
          }),
          albumItem({
            id: 'c'.repeat(22),
            uri: `spotify:track:${'c'.repeat(22)}`,
            name: 'Region-blocked',
            is_playable: false,
          }),
        ],
        next: null,
      }),
    );
    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.title).toBe('Playable');
    expect(result.skipped).toBe(1);
  });

  it('skips items with null id (defensive)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      albumBootstrap({
        items: [
          albumItem({ id: 'b'.repeat(22) }),
          albumItem({ id: null, uri: 'spotify:track:????' }),
        ],
        next: null,
      }),
    );
    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('omits artworkUrl when the album has no images', async () => {
    // Defensive: a few back-catalog albums have empty images arrays.
    // The bootstrap response carries the images, so no images on
    // bootstrap means no artwork on any track.
    const fetchImpl: FetchLike = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: ALBUM_ID,
          name: 'No-Art Album',
          artists: [{ name: 'Anon' }],
          images: [],
          tracks: { next: null, items: [albumItemId('a')] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks[0]?.artworkUrl).toBeUndefined();
  });
});

describe('fetchAlbumTracks — error mapping', () => {
  it('maps 404 to SpotifyTrackError reason="not-found"', async () => {
    await expect(
      fetchAlbumTracks(ALBUM_ID, TOKEN, mockStatus(404)),
    ).rejects.toMatchObject({
      reason: 'not-found',
      trackId: ALBUM_ID,
    });
  });

  it('maps 401 to SpotifyTrackError reason="auth-required"', async () => {
    await expect(
      fetchAlbumTracks(ALBUM_ID, TOKEN, mockStatus(401)),
    ).rejects.toMatchObject({
      reason: 'auth-required',
      trackId: ALBUM_ID,
    });
  });

  it('maps 500 to SpotifyTrackError reason="network"', async () => {
    await expect(
      fetchAlbumTracks(ALBUM_ID, TOKEN, mockStatus(500)),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: ALBUM_ID,
    });
  });

  it('maps fetch throw to SpotifyTrackError reason="network"', async () => {
    const broken: FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      fetchAlbumTracks(ALBUM_ID, TOKEN, broken),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: ALBUM_ID,
    });
  });

  it('maps a malformed bootstrap response to reason="network"', async () => {
    // `tracks` field missing — the album bootstrap schema rejects.
    const malformed: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ id: ALBUM_ID, name: 'X' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      fetchAlbumTracks(ALBUM_ID, TOKEN, malformed),
    ).rejects.toMatchObject({
      reason: 'network',
      trackId: ALBUM_ID,
    });
  });
});

describe('fetchAlbumTracks — 429 retry', () => {
  it('retries once after Retry-After on bootstrap, then succeeds', async () => {
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return albumBootstrap({ items: [albumItemId('a')], next: null });
    });
    const result = await fetchAlbumTracks(ALBUM_ID, TOKEN, fetchImpl);
    expect(result.tracks).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
