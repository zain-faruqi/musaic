/**
 * Tests for the Spotify save / import pipelines.
 *
 * saveSpotifyTrack, importSpotifyPlaylist, and importSpotifyAlbum
 * run against a fresh in-memory SQLite DB with the post-0003 schema
 * applied; `getToken`, `fetchMetadata` / `fetchPlaylist` /
 * `fetchAlbum`, and `broadcast` are injected as stubs.
 *
 * saveSpotifyTrack's signature is `(parsed, { db, getToken,
 * fetchMetadata?, now? })` to match the discriminated-dispatch
 * shape importSpotifyPlaylist also uses. Tests pass parsed inputs
 * directly rather than raw strings.
 *
 * importSpotifyAlbum mirrors importSpotifyPlaylist structurally.
 * Test coverage mirrors the playlist tests as a regression suite
 * for the shared-helper extraction
 * (`buildPerPageUpsert`, `mapImportError`).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/runner';
import { getTrack } from '../db/tracks';
import type {
  ParsedSpotifyAlbum,
  ParsedSpotifyPlaylist,
  ParsedSpotifyTrack,
} from './parse-uri';
import {
  SpotifyTrackError,
  type PlaylistImportResult,
  type SpotifyTrackMetadata,
} from './web-api';
import {
  importSpotifyAlbum,
  importSpotifyPlaylist,
  saveSpotifyTrack,
  type FetchSpotifyAlbum,
  type FetchSpotifyMetadata,
  type FetchSpotifyPlaylist,
  type GetAccessToken,
} from './save';

const schemaMigration = {
  version: 1,
  name: 'initial',
  sql: `
    CREATE TABLE tracks (
      source       TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      path         TEXT,
      title        TEXT NOT NULL,
      artists      TEXT NOT NULL,
      album        TEXT,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      isrc         TEXT,
      artwork_url  TEXT,
      mtime        INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (source, source_id)
    );
  `,
};

const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';
const URI = `spotify:track:${TRACK_ID}`;
const TOKEN = 'BQfake-token';

const PARSED_TRACK: ParsedSpotifyTrack = {
  kind: 'track',
  trackId: TRACK_ID,
  uri: URI,
};

const PLAYLIST_ID = '2NQjdk518rsx5awjyphz5E';
const PLAYLIST_URI = `spotify:playlist:${PLAYLIST_ID}`;
const PARSED_PLAYLIST: ParsedSpotifyPlaylist = {
  kind: 'playlist',
  playlistId: PLAYLIST_ID,
  uri: PLAYLIST_URI,
};

const ALBUM_ID = '4yP0hdKOZPNshxUOjY0cZj';
const ALBUM_URI = `spotify:album:${ALBUM_ID}`;
const PARSED_ALBUM: ParsedSpotifyAlbum = {
  kind: 'album',
  albumId: ALBUM_ID,
  uri: ALBUM_URI,
};

const META: SpotifyTrackMetadata = {
  trackId: TRACK_ID,
  uri: URI,
  title: 'Blinding Lights',
  artists: ['The Weeknd'],
  album: 'After Hours',
  durationMs: 200040,
  artworkUrl: 'https://i.scdn.co/image/300.jpg',
  isrc: 'USUG11904206',
};

const okToken: GetAccessToken = () => Promise.resolve(TOKEN);
const noToken: GetAccessToken = () => Promise.resolve(null);

const okFetch: FetchSpotifyMetadata = vi.fn(async () => META);

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  migrate(db, [schemaMigration]);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

// --- saveSpotifyTrack ---------------------------------------------------

describe('saveSpotifyTrack — happy path', () => {
  it('fetches metadata and upserts the row', async () => {
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: okFetch,
      now: 1234,
    });

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('unreachable');
    expect(result.track).toMatchObject({
      source: 'spotify',
      // sourceId is the canonical URI form, not the bare trackId.
      // The `sourceId` invariant is "the Spotify URI" — and
      // SpotifyAdapter relies on this when it
      // sends `{ uris: [track.sourceId] }` to PUT /me/player/play.
      sourceId: URI,
      title: 'Blinding Lights',
      artists: ['The Weeknd'],
      album: 'After Hours',
      durationMs: 200040,
      artwork: 'https://i.scdn.co/image/300.jpg',
      isrc: 'USUG11904206',
    });

    const row = getTrack(db, 'spotify', URI);
    expect(row).toBeDefined();
    expect(row?.created_at).toBe(1234);
    expect(row?.mtime).toBe(1234);
  });

  it('preserves created_at on re-save', async () => {
    await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: okFetch,
      now: 1000,
    });
    await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: okFetch,
      now: 9999,
    });
    const row = getTrack(db, 'spotify', URI);
    expect(row?.created_at).toBe(1000);
    expect(row?.mtime).toBe(9999); // mtime DOES update
  });

  it('persists null artwork when metadata has none', async () => {
    const noArt: FetchSpotifyMetadata = async () => ({
      trackId: TRACK_ID,
      uri: URI,
      title: 'X',
      artists: ['Y'],
      album: 'Z',
      durationMs: 1,
    });
    await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: noArt,
      now: 1,
    });
    const row = getTrack(db, 'spotify', URI);
    expect(row?.artwork_url).toBe(null);
  });

  it('passes the bare access token + trackId through to fetchMetadata', async () => {
    // fetchMetadata is keyed on the bare trackId (it builds
    // `GET /v1/tracks/{id}` with the bare ID). Only source_id
    // storage uses the URI form.
    const spy: FetchSpotifyMetadata = vi.fn(async () => META);
    await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: spy,
    });
    expect(spy).toHaveBeenCalledWith(TRACK_ID, TOKEN);
  });
});

describe('saveSpotifyTrack — error mapping', () => {
  it('returns auth-required when no token is stored', async () => {
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: noToken,
      fetchMetadata: okFetch,
    });
    expect(result).toEqual({ kind: 'auth-required' });
    expect(getTrack(db, 'spotify', URI)).toBeUndefined();
  });

  it('returns not-found when Web API returns 404', async () => {
    const notFound: FetchSpotifyMetadata = async () => {
      throw new SpotifyTrackError(TRACK_ID, 'not-found', 'HTTP 404');
    };
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: notFound,
    });
    expect(result).toEqual({ kind: 'not-found' });
    expect(getTrack(db, 'spotify', URI)).toBeUndefined();
  });

  it('returns auth-required when Web API returns 401', async () => {
    const authErr: FetchSpotifyMetadata = async () => {
      throw new SpotifyTrackError(TRACK_ID, 'auth-required', 'HTTP 401');
    };
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: authErr,
    });
    expect(result).toEqual({ kind: 'auth-required' });
  });

  it('returns network-error when Web API returns 429', async () => {
    const rateLimit: FetchSpotifyMetadata = async () => {
      throw new SpotifyTrackError(TRACK_ID, 'rate-limited', 'HTTP 429');
    };
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: rateLimit,
    });
    expect(result).toEqual({ kind: 'network-error' });
  });

  it('returns network-error on a fetch throw', async () => {
    const networkFail: FetchSpotifyMetadata = async () => {
      throw new SpotifyTrackError(TRACK_ID, 'network', 'fetch failed');
    };
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: networkFail,
    });
    expect(result).toEqual({ kind: 'network-error' });
  });

  it('re-throws non-SpotifyTrackError errors (unexpected)', async () => {
    const surprise: FetchSpotifyMetadata = async () => {
      throw new Error('something else entirely');
    };
    await expect(
      saveSpotifyTrack(PARSED_TRACK, {
        db,
        getToken: okToken,
        fetchMetadata: surprise,
      }),
    ).rejects.toThrow('something else entirely');
  });
});

// --- importSpotifyPlaylist ---------------------------------------------

/** Build a SpotifyTrackMetadata with a synthesized 22-char id. */
const meta = (idChar: string): SpotifyTrackMetadata => {
  const id = idChar.repeat(22);
  return {
    trackId: id,
    uri: `spotify:track:${id}`,
    title: `Track ${idChar}`,
    artists: ['Artist'],
    album: 'Album',
    durationMs: 200000,
  };
};

describe('importSpotifyPlaylist — happy path', () => {
  it('upserts every track and preserves order via added_at increments', async () => {
    const tracks = [meta('a'), meta('b'), meta('c')];
    const fetchPlaylist: FetchSpotifyPlaylist = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded(tracks, 0);
      return { tracks, skipped: 0, truncated: false };
    };

    const broadcast = vi.fn();
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast,
      now: 1_000_000,
    });

    expect(outcome).toEqual({
      kind: 'imported',
      result: {
        imported: 3,
        skipped: 0,
        truncated: false,
        refs: [
          { source: 'spotify', sourceId: `spotify:track:${'a'.repeat(22)}` },
          { source: 'spotify', sourceId: `spotify:track:${'b'.repeat(22)}` },
          { source: 'spotify', sourceId: `spotify:track:${'c'.repeat(22)}` },
        ],
      },
    });

    // Order: created_at = baseTime + i. Track 'a' at 1_000_000,
    // 'b' at 1_000_001, 'c' at 1_000_002.
    expect(getTrack(db, 'spotify', `spotify:track:${'a'.repeat(22)}`)?.created_at).toBe(1_000_000);
    expect(getTrack(db, 'spotify', `spotify:track:${'b'.repeat(22)}`)?.created_at).toBe(1_000_001);
    expect(getTrack(db, 'spotify', `spotify:track:${'c'.repeat(22)}`)?.created_at).toBe(1_000_002);
  });

  it('threads added_at index across multiple pages', async () => {
    // 2 pages, 3 tracks each. Final created_at should be
    // baseTime + 0 .. baseTime + 5 across both pages.
    const page1 = [meta('a'), meta('b'), meta('c')];
    const page2 = [meta('d'), meta('e'), meta('f')];

    const fetchPlaylist: FetchSpotifyPlaylist = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded(page1, 0);
      await onPageDecoded(page2, 1);
      return {
        tracks: [...page1, ...page2],
        skipped: 0,
        truncated: false,
      };
    };

    await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
      now: 2_000_000,
    });

    expect(getTrack(db, 'spotify', `spotify:track:${'a'.repeat(22)}`)?.created_at).toBe(2_000_000);
    expect(getTrack(db, 'spotify', `spotify:track:${'c'.repeat(22)}`)?.created_at).toBe(2_000_002);
    // Page 2 starts at offset 3 — track 'd' = baseTime + 3.
    expect(getTrack(db, 'spotify', `spotify:track:${'d'.repeat(22)}`)?.created_at).toBe(2_000_003);
    expect(getTrack(db, 'spotify', `spotify:track:${'f'.repeat(22)}`)?.created_at).toBe(2_000_005);
  });

  it('broadcasts library:changed once per non-empty page', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded([meta('a'), meta('b')], 0);
      await onPageDecoded([meta('c')], 1);
      await onPageDecoded([meta('d')], 2);
      const all = [meta('a'), meta('b'), meta('c'), meta('d')];
      return { tracks: all, skipped: 0, truncated: false };
    };

    const broadcast = vi.fn();
    await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast,
      now: 5_000,
    });

    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it('does NOT broadcast for empty pages (all tracks filtered out upstream)', async () => {
    // A page with zero playable tracks (everything tombstoned /
    // is_local) shouldn't trigger a re-fetch — there'd be nothing
    // new for the renderer to render.
    const fetchPlaylist: FetchSpotifyPlaylist = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded([meta('a')], 0);
      await onPageDecoded([], 1); // empty page
      await onPageDecoded([meta('b')], 2);
      return { tracks: [meta('a'), meta('b')], skipped: 5, truncated: false };
    };

    const broadcast = vi.fn();
    await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast,
      now: 1,
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('threads skipped count through unchanged', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded([meta('a')], 0);
      return { tracks: [meta('a')], skipped: 7, truncated: false };
    };

    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
    });
    expect(outcome).toEqual({
      kind: 'imported',
      result: {
        imported: 1,
        skipped: 7,
        truncated: false,
        refs: [
          { source: 'spotify', sourceId: `spotify:track:${'a'.repeat(22)}` },
        ],
      },
    });
  });

  it('threads truncated flag through unchanged', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded([meta('a')], 0);
      return { tracks: [meta('a')], skipped: 0, truncated: true };
    };

    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
    });
    expect(outcome).toEqual({
      kind: 'imported',
      result: {
        imported: 1,
        skipped: 0,
        truncated: true,
        refs: [
          { source: 'spotify', sourceId: `spotify:track:${'a'.repeat(22)}` },
        ],
      },
    });
  });

  it('preserves existing created_at on conflict (already-saved tracks keep position)', async () => {
    // Pre-populate the DB with one of the playlist tracks at an
    // earlier timestamp. After import, that row should keep its
    // original created_at; the others land at the new base.
    const existingUri = `spotify:track:${'a'.repeat(22)}`;

    // First import sets the baseline at t=1000.
    const firstImport: FetchSpotifyPlaylist = async (_id, _t, onPage) => {
      await onPage([meta('a')], 0);
      return { tracks: [meta('a')], skipped: 0, truncated: false };
    };
    await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist: firstImport,
      broadcast: () => {},
      now: 1000,
    });
    expect(getTrack(db, 'spotify', existingUri)?.created_at).toBe(1000);

    // Second import at t=5_000_000 reincludes 'a' alongside 'b' and 'c'.
    const secondImport: FetchSpotifyPlaylist = async (_id, _t, onPage) => {
      const all = [meta('a'), meta('b'), meta('c')];
      await onPage(all, 0);
      return { tracks: all, skipped: 0, truncated: false };
    };
    await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist: secondImport,
      broadcast: () => {},
      now: 5_000_000,
    });

    // 'a' kept its original created_at (1000); 'b' and 'c' get
    // baseTime + 1 and baseTime + 2 respectively (the runningIndex
    // counts every track encountered, not just new ones — so the
    // index for 'b' is 1, not 0).
    expect(getTrack(db, 'spotify', existingUri)?.created_at).toBe(1000);
    expect(getTrack(db, 'spotify', `spotify:track:${'b'.repeat(22)}`)?.created_at).toBe(
      5_000_001,
    );
    expect(getTrack(db, 'spotify', `spotify:track:${'c'.repeat(22)}`)?.created_at).toBe(
      5_000_002,
    );
  });
});

describe('importSpotifyPlaylist — error mapping', () => {
  it('returns auth-required when no token is stored', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = vi.fn();
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: noToken,
      fetchPlaylist,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'auth-required' });
    // Fetch shouldn't have been called.
    expect(fetchPlaylist).not.toHaveBeenCalled();
  });

  it('returns not-found when fetchPlaylist throws not-found', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = async () => {
      throw new SpotifyTrackError(PLAYLIST_ID, 'not-found', 'HTTP 404');
    };
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('returns auth-required when fetchPlaylist throws auth-required', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = async () => {
      throw new SpotifyTrackError(PLAYLIST_ID, 'auth-required', 'HTTP 401');
    };
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'auth-required' });
  });

  it('returns network-error for rate-limited and network reasons', async () => {
    for (const reason of ['rate-limited', 'network'] as const) {
      const fetchPlaylist: FetchSpotifyPlaylist = async () => {
        throw new SpotifyTrackError(PLAYLIST_ID, reason, 'whatever');
      };
      const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
        db,
        getToken: okToken,
        fetchPlaylist,
        broadcast: () => {},
      });
      expect(outcome).toEqual({ kind: 'network-error' });
    }
  });

  it('re-throws non-SpotifyTrackError errors (unexpected)', async () => {
    const fetchPlaylist: FetchSpotifyPlaylist = async () => {
      throw new Error('boom');
    };
    await expect(
      importSpotifyPlaylist(PARSED_PLAYLIST, {
        db,
        getToken: okToken,
        fetchPlaylist,
        broadcast: () => {},
      }),
    ).rejects.toThrow('boom');
  });

  it('keeps already-upserted pages in the library when a later page fails', async () => {
    // Mid-import failure semantics: the renderer has already seen
    // page 0's broadcast and re-fetched, so dropping those rows
    // would feel like a flash. Spec is "broadcasted pages stay".
    const fetchPlaylist: FetchSpotifyPlaylist = async (_id, _token, onPage) => {
      await onPage([meta('a'), meta('b')], 0);
      throw new SpotifyTrackError(PLAYLIST_ID, 'network', 'page 1 died');
    };
    const result: PlaylistImportResult | undefined = undefined;
    void result;
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
      now: 1,
    });
    expect(outcome).toEqual({ kind: 'network-error' });
    expect(getTrack(db, 'spotify', `spotify:track:${'a'.repeat(22)}`)).toBeDefined();
    expect(getTrack(db, 'spotify', `spotify:track:${'b'.repeat(22)}`)).toBeDefined();
  });
});

// --- importSpotifyAlbum --------------------------------------

describe('importSpotifyAlbum — happy path', () => {
  it('upserts every track and preserves order via added_at increments', async () => {
    // Mirrors the playlist happy-path test. Same per-page upsert
    // semantics — `buildPerPageUpsert` is shared. The album importer
    // is otherwise a thin wrapper around the album fetch seam.
    const tracks = [meta('a'), meta('b'), meta('c')];
    const fetchAlbum: FetchSpotifyAlbum = async (
      _id,
      _token,
      onPageDecoded,
    ) => {
      await onPageDecoded(tracks, 0);
      return { tracks, skipped: 0, truncated: false };
    };

    const broadcast = vi.fn();
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast,
      now: 2_000_000,
    });

    expect(outcome).toEqual({
      kind: 'imported',
      result: {
        imported: 3,
        skipped: 0,
        truncated: false,
        refs: [
          { source: 'spotify', sourceId: `spotify:track:${'a'.repeat(22)}` },
          { source: 'spotify', sourceId: `spotify:track:${'b'.repeat(22)}` },
          { source: 'spotify', sourceId: `spotify:track:${'c'.repeat(22)}` },
        ],
      },
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(getTrack(db, 'spotify', `spotify:track:${'a'.repeat(22)}`)?.created_at).toBe(2_000_000);
    expect(getTrack(db, 'spotify', `spotify:track:${'b'.repeat(22)}`)?.created_at).toBe(2_000_001);
    expect(getTrack(db, 'spotify', `spotify:track:${'c'.repeat(22)}`)?.created_at).toBe(2_000_002);
  });

  it('preserves created_at on re-import of an already-present track (idempotency)', async () => {
    // An already-imported track keeps its original created_at when
    // the album is re-pasted — `upsertTrack`'s ON CONFLICT preserves
    // the column. This is the same "scattered position" edge as
    // playlists: the user's intent of "I want to listen to this
    // album now" is honored for new additions only.
    const original = meta('a');

    // First import seeds the row at baseTime=500.
    const firstFetch: FetchSpotifyAlbum = async (_id, _token, cb) => {
      await cb([original], 0);
      return { tracks: [original], skipped: 0, truncated: false };
    };
    await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum: firstFetch,
      broadcast: () => {},
      now: 500,
    });
    expect(getTrack(db, 'spotify', original.uri)?.created_at).toBe(500);

    // Re-import with a different baseTime; created_at must not move.
    const secondFetch: FetchSpotifyAlbum = async (_id, _token, cb) => {
      await cb([original], 0);
      return { tracks: [original], skipped: 0, truncated: false };
    };
    await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum: secondFetch,
      broadcast: () => {},
      now: 9_999_999,
    });
    expect(getTrack(db, 'spotify', original.uri)?.created_at).toBe(500);
  });

  it('skips broadcast when the page is empty', async () => {
    const fetchAlbum: FetchSpotifyAlbum = async (_id, _token, cb) => {
      await cb([], 0);
      return { tracks: [], skipped: 5, truncated: false };
    };
    const broadcast = vi.fn();
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast,
      now: 1,
    });
    expect(outcome).toEqual({
      kind: 'imported',
      result: { imported: 0, skipped: 5, truncated: false, refs: [] },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('importSpotifyAlbum — error mapping', () => {
  it('returns auth-required when getToken returns null', async () => {
    const fetchAlbum: FetchSpotifyAlbum = vi.fn();
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: noToken,
      fetchAlbum,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'auth-required' });
    expect(fetchAlbum).not.toHaveBeenCalled();
  });

  it('maps SpotifyTrackError reason=auth-required to auth-required', async () => {
    const fetchAlbum: FetchSpotifyAlbum = async () => {
      throw new SpotifyTrackError(ALBUM_ID, 'auth-required', 'HTTP 401');
    };
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'auth-required' });
  });

  it('maps SpotifyTrackError reason=not-found to not-found', async () => {
    const fetchAlbum: FetchSpotifyAlbum = async () => {
      throw new SpotifyTrackError(ALBUM_ID, 'not-found', 'HTTP 404');
    };
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('maps SpotifyTrackError reason=network to network-error', async () => {
    const fetchAlbum: FetchSpotifyAlbum = async () => {
      throw new SpotifyTrackError(ALBUM_ID, 'network', 'fetch failed');
    };
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'network-error' });
  });

  it('maps SpotifyTrackError reason=rate-limited to network-error', async () => {
    const fetchAlbum: FetchSpotifyAlbum = async () => {
      throw new SpotifyTrackError(ALBUM_ID, 'rate-limited', 'HTTP 429');
    };
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast: () => {},
    });
    expect(outcome).toEqual({ kind: 'network-error' });
  });

  it('re-throws unexpected errors instead of swallowing them', async () => {
    // Non-SpotifyTrackError errors must propagate — they indicate a
    // bug, not a categorized API failure. Same contract as the
    // playlist importer.
    const fetchAlbum: FetchSpotifyAlbum = async () => {
      throw new RangeError('something bug-shaped');
    };
    await expect(
      importSpotifyAlbum(PARSED_ALBUM, {
        db,
        getToken: okToken,
        fetchAlbum,
        broadcast: () => {},
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('keeps successfully-upserted pages when a later page errors', async () => {
    // Mid-import failure: page 0 upserts, page 1 throws. Page 0
    // tracks must remain in the library. Mirrors the playlist
    // mid-error test exactly.
    const fetchAlbum: FetchSpotifyAlbum = async (_id, _token, cb) => {
      await cb([meta('a'), meta('b')], 0);
      throw new SpotifyTrackError(ALBUM_ID, 'network', 'page 1 fetch failed');
    };
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast: () => {},
      now: 1,
    });
    expect(outcome).toEqual({ kind: 'network-error' });
    expect(getTrack(db, 'spotify', `spotify:track:${'a'.repeat(22)}`)).toBeDefined();
    expect(getTrack(db, 'spotify', `spotify:track:${'b'.repeat(22)}`)).toBeDefined();
  });
});

// --- refs plumbing -------------------------------------------

/**
 * Every success outcome carries a `refs: readonly TrackRef[]` field
 * so the renderer's paste-to-add path in the Add Tracks picker can
 * deterministically auto-select tracks that just landed in
 * the library. The picker can't snapshot-diff against the library
 * store because there's a race between `library:changed` (broadcast
 * per page) and the IPC response resolution; refs sidesteps it.
 *
 * Coverage below confirms refs are produced in shape across all three
 * save paths and that the bulk refs include already-in-library
 * conflict-skip refs (the picker auto-selects them too, since they're
 * library-resident regardless of whether the upsert was an insert).
 */
describe('refs plumbing', () => {
  it('saveSpotifyTrack returns a single-element refs array keyed on the canonical URI', async () => {
    const result = await saveSpotifyTrack(PARSED_TRACK, {
      db,
      getToken: okToken,
      fetchMetadata: okFetch,
      now: 1,
    });
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('unreachable');
    expect(result.refs).toEqual([{ source: 'spotify', sourceId: URI }]);
  });

  it('importSpotifyPlaylist returns refs for every upserted track, in page order', async () => {
    const tracks = [meta('a'), meta('b'), meta('c')];
    const fetchPlaylist: FetchSpotifyPlaylist = async (_id, _token, onPage) => {
      await onPage(tracks, 0);
      return { tracks, skipped: 0, truncated: false };
    };
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
      now: 1,
    });
    expect(outcome.kind).toBe('imported');
    if (outcome.kind !== 'imported') throw new Error('unreachable');
    expect(outcome.result.refs).toEqual([
      { source: 'spotify', sourceId: `spotify:track:${'a'.repeat(22)}` },
      { source: 'spotify', sourceId: `spotify:track:${'b'.repeat(22)}` },
      { source: 'spotify', sourceId: `spotify:track:${'c'.repeat(22)}` },
    ]);
  });

  it('importSpotifyPlaylist threads refs across multiple pages in arrival order', async () => {
    // Two pages, three tracks each. The picker reads refs in this
    // order to map back to availableTracks; preserving page-major,
    // in-page order keeps the mapping deterministic.
    const page1 = [meta('a'), meta('b'), meta('c')];
    const page2 = [meta('d'), meta('e'), meta('f')];
    const fetchPlaylist: FetchSpotifyPlaylist = async (_id, _token, onPage) => {
      await onPage(page1, 0);
      await onPage(page2, 1);
      return {
        tracks: [...page1, ...page2],
        skipped: 0,
        truncated: false,
      };
    };
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist,
      broadcast: () => {},
      now: 1,
    });
    if (outcome.kind !== 'imported') throw new Error('unreachable');
    expect(outcome.result.refs.map((r) => r.sourceId)).toEqual([
      `spotify:track:${'a'.repeat(22)}`,
      `spotify:track:${'b'.repeat(22)}`,
      `spotify:track:${'c'.repeat(22)}`,
      `spotify:track:${'d'.repeat(22)}`,
      `spotify:track:${'e'.repeat(22)}`,
      `spotify:track:${'f'.repeat(22)}`,
    ]);
  });

  it('importSpotifyPlaylist includes refs for already-in-library tracks (conflict-skip)', async () => {
    // The picker should auto-select tracks that the upsert skipped
    // because they were already in the library — the row is library-
    // resident either way. Pre-seed 'a' before the import so its
    // upsert hits ON CONFLICT; 'a' must still appear in refs.
    const existing = meta('a');
    await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist: async (_id, _t, cb) => {
        await cb([existing], 0);
        return { tracks: [existing], skipped: 0, truncated: false };
      },
      broadcast: () => {},
      now: 1000,
    });
    // Re-import 'a' (already in db) plus 'b' (new).
    const outcome = await importSpotifyPlaylist(PARSED_PLAYLIST, {
      db,
      getToken: okToken,
      fetchPlaylist: async (_id, _t, cb) => {
        const all = [existing, meta('b')];
        await cb(all, 0);
        return { tracks: all, skipped: 0, truncated: false };
      },
      broadcast: () => {},
      now: 2_000_000,
    });
    if (outcome.kind !== 'imported') throw new Error('unreachable');
    // Both refs present, in order. 'a' is library-resident from the
    // prior import; 'b' is freshly inserted; both are auto-select
    // candidates from the picker's point of view.
    expect(outcome.result.refs).toEqual([
      { source: 'spotify', sourceId: existing.uri },
      { source: 'spotify', sourceId: `spotify:track:${'b'.repeat(22)}` },
    ]);
  });

  it('importSpotifyAlbum returns refs for every upserted track', async () => {
    const tracks = [meta('a'), meta('b')];
    const fetchAlbum: FetchSpotifyAlbum = async (_id, _t, onPage) => {
      await onPage(tracks, 0);
      return { tracks, skipped: 0, truncated: false };
    };
    const outcome = await importSpotifyAlbum(PARSED_ALBUM, {
      db,
      getToken: okToken,
      fetchAlbum,
      broadcast: () => {},
      now: 1,
    });
    if (outcome.kind !== 'imported') throw new Error('unreachable');
    expect(outcome.result.refs).toEqual([
      { source: 'spotify', sourceId: `spotify:track:${'a'.repeat(22)}` },
      { source: 'spotify', sourceId: `spotify:track:${'b'.repeat(22)}` },
    ]);
  });
});
