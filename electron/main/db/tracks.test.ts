import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './runner';
import { trackRowToUnifiedTrack } from './schema';
import {
  deleteByPath,
  deleteTrack,
  getAllTracks,
  getTrack,
  upsertTrack,
} from './tracks';

/**
 * Inline schema fixture. The post-0002 shape lives here directly
 * rather than chaining 0001 + 0002 because the per-table tests don't
 * care how we got to the final schema — only that the queries against
 * it work. The migration chain itself is covered by the dedicated
 * migration tests in runner.test.ts (and an integration test against
 * legacy rows below).
 */
const initialMigration = {
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

function makeLocalRow(overrides: Record<string, unknown> = {}) {
  const path = '/Users/x/Music/Musaic/song.mp3';
  return {
    source: 'local' as const,
    source_id: path,
    path,
    title: 'A Song',
    artists: JSON.stringify(['Artist One']),
    album: 'An Album',
    duration_ms: 180_000,
    isrc: 'USRC17600001',
    artwork_url: null as string | null,
    mtime: 1_700_000_000,
    created_at: 1_700_000_000,
    ...overrides,
  };
}

function makeYouTubeRow(overrides: Record<string, unknown> = {}) {
  const videoId = 'dQw4w9WgXcQ';
  return {
    source: 'youtube' as const,
    source_id: videoId,
    path: null as string | null,
    title: 'Never Gonna Give You Up',
    artists: JSON.stringify(['Rick Astley']),
    album: null as string | null,
    duration_ms: 0,
    isrc: null as string | null,
    artwork_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' as string | null,
    mtime: 1_700_000_000,
    created_at: 1_700_000_000,
    ...overrides,
  };
}

describe('tracks table', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    migrate(db, [initialMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('upsert + getTrack roundtrip preserves all fields (local)', () => {
    const row = makeLocalRow();
    upsertTrack(db, row);
    expect(getTrack(db, 'local', row.source_id)).toEqual(row);
  });

  it('upsert + getTrack roundtrip preserves all fields (youtube)', () => {
    const row = makeYouTubeRow();
    upsertTrack(db, row);
    expect(getTrack(db, 'youtube', row.source_id)).toEqual(row);
  });

  it('returns undefined for a non-existent (source, source_id)', () => {
    expect(getTrack(db, 'local', '/nope.mp3')).toBeUndefined();
    expect(getTrack(db, 'youtube', 'noVideoIdXX')).toBeUndefined();
  });

  it('upsert on conflict updates fields but preserves created_at', () => {
    upsertTrack(db, makeLocalRow({ created_at: 1_700_000_000 }));
    upsertTrack(
      db,
      makeLocalRow({
        title: 'Updated Title',
        created_at: 1_800_000_000,
        mtime: 1_800_000_000,
      }),
    );
    const row = getTrack(db, 'local', '/Users/x/Music/Musaic/song.mp3');
    expect(row?.title).toBe('Updated Title');
    expect(row?.mtime).toBe(1_800_000_000);
    expect(row?.created_at).toBe(1_700_000_000);
  });

  it('local and youtube rows coexist under the composite PK', () => {
    // Same source_id string for both sources is allowed by the PK
    // (different source dimension). Unrealistic but proves the PK
    // shape: rows aren't collapsed by source_id alone.
    upsertTrack(db, makeLocalRow({ source_id: 'collision', path: 'collision' }));
    upsertTrack(db, makeYouTubeRow({ source_id: 'collision' }));
    expect(getTrack(db, 'local', 'collision')?.title).toBe('A Song');
    expect(getTrack(db, 'youtube', 'collision')?.title).toBe(
      'Never Gonna Give You Up',
    );
  });

  it('handles nullable fields (local: artwork_url null)', () => {
    upsertTrack(db, makeLocalRow({ album: null, isrc: null }));
    const row = getTrack(db, 'local', '/Users/x/Music/Musaic/song.mp3');
    expect(row?.album).toBeNull();
    expect(row?.isrc).toBeNull();
    expect(row?.artwork_url).toBeNull();
  });

  it('survives commas inside artist names (JSON roundtrip)', () => {
    const tricky = ['Earth, Wind & Fire', 'Tyler, the Creator'];
    upsertTrack(db, makeLocalRow({ artists: JSON.stringify(tricky) }));
    const row = getTrack(db, 'local', '/Users/x/Music/Musaic/song.mp3');
    expect(JSON.parse(row!.artists)).toEqual(tricky);

    const unified = trackRowToUnifiedTrack(row!);
    expect(unified.artists).toEqual(tricky);
  });

  it('getAllTracks returns every inserted row across sources', () => {
    upsertTrack(db, makeLocalRow({ source_id: '/a.mp3', path: '/a.mp3' }));
    upsertTrack(db, makeYouTubeRow({ source_id: 'aaaaaaaaaaa' }));
    upsertTrack(db, makeLocalRow({ source_id: '/b.mp3', path: '/b.mp3' }));
    expect(getAllTracks(db)).toHaveLength(3);
  });

  it('getAllTracks returns rows ordered by created_at DESC', () => {
    // Insert out of order to be sure the SQL ORDER BY (not insertion
    // order) is what's being asserted. Mixed sources to confirm the
    // ordering is source-agnostic.
    upsertTrack(db, makeLocalRow({ source_id: '/middle.mp3', path: '/middle.mp3', created_at: 200 }));
    upsertTrack(db, makeYouTubeRow({ source_id: 'oldestVidXX', created_at: 100 }));
    upsertTrack(db, makeLocalRow({ source_id: '/newest.mp3', path: '/newest.mp3', created_at: 300 }));
    const ids = getAllTracks(db).map((r) => r.source_id);
    expect(ids).toEqual(['/newest.mp3', '/middle.mp3', 'oldestVidXX']);
  });

  it('deleteTrack removes the row keyed by (source, source_id)', () => {
    upsertTrack(db, makeLocalRow({ source_id: '/x.mp3', path: '/x.mp3' }));
    upsertTrack(db, makeYouTubeRow({ source_id: 'yt-x' }));
    deleteTrack(db, 'local', '/x.mp3');
    expect(getTrack(db, 'local', '/x.mp3')).toBeUndefined();
    // YouTube row untouched.
    expect(getTrack(db, 'youtube', 'yt-x')).toBeDefined();
  });

  it('deleteTrack is a no-op when the (source, source_id) is not in the table', () => {
    expect(() =>
      deleteTrack(db, 'local', '/never-existed.mp3'),
    ).not.toThrow();
  });

  describe('deleteByPath', () => {
    it('removes a local row by path', () => {
      upsertTrack(db, makeLocalRow({ source_id: '/x.mp3', path: '/x.mp3' }));
      deleteByPath(db, '/x.mp3');
      expect(getTrack(db, 'local', '/x.mp3')).toBeUndefined();
    });

    it('leaves youtube rows alone even if a videoId happens to match a path string', () => {
      // Defensive against the "collision" scenario in the PK test
      // above — a watcher unlink event for /foo must not delete a
      // hypothetical youtube row whose videoId is the string /foo.
      // (Unrealistic in practice — videoIds are 11 chars — but the
      // deleteByPath filter is the guarantee.)
      upsertTrack(db, makeYouTubeRow({ source_id: '/whatever' }));
      upsertTrack(db, makeLocalRow({ source_id: '/whatever', path: '/whatever' }));
      deleteByPath(db, '/whatever');
      expect(getTrack(db, 'local', '/whatever')).toBeUndefined();
      expect(getTrack(db, 'youtube', '/whatever')).toBeDefined();
    });

    it('is a no-op when the path is not in the table', () => {
      // The watcher's unlink handler may fire for files we never
      // indexed — this must not throw.
      expect(() => deleteByPath(db, '/never-existed.mp3')).not.toThrow();
    });
  });
});

describe('trackRowToUnifiedTrack', () => {
  it('builds the id from source and source_id (local)', () => {
    const unified = trackRowToUnifiedTrack({
      source: 'local',
      source_id: '/Music/Musaic/x.mp3',
      path: '/Music/Musaic/x.mp3',
      title: 'X',
      artists: JSON.stringify(['Y']),
      album: null,
      duration_ms: 1000,
      isrc: null,
      artwork_url: null,
      mtime: 0,
      created_at: 0,
    });
    expect(unified.id).toBe('local:/Music/Musaic/x.mp3');
    expect(unified.source).toBe('local');
    expect(unified.sourceId).toBe('/Music/Musaic/x.mp3');
  });

  it('builds the id from source and source_id (youtube)', () => {
    const unified = trackRowToUnifiedTrack({
      source: 'youtube',
      source_id: 'dQw4w9WgXcQ',
      path: null,
      title: 'X',
      artists: JSON.stringify(['Y']),
      album: null,
      duration_ms: 0,
      isrc: null,
      artwork_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      mtime: 0,
      created_at: 0,
    });
    expect(unified.id).toBe('youtube:dQw4w9WgXcQ');
    expect(unified.source).toBe('youtube');
    expect(unified.sourceId).toBe('dQw4w9WgXcQ');
    expect(unified.artwork).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    );
  });

  it('omits album / isrc / artwork when null', () => {
    const unified = trackRowToUnifiedTrack({
      source: 'local',
      source_id: '/x.mp3',
      path: '/x.mp3',
      title: 'X',
      artists: JSON.stringify(['Y']),
      album: null,
      duration_ms: 0,
      isrc: null,
      artwork_url: null,
      mtime: 0,
      created_at: 0,
    });
    expect(unified).not.toHaveProperty('album');
    expect(unified).not.toHaveProperty('isrc');
    expect(unified).not.toHaveProperty('artwork');
  });

  it('includes album / isrc / artwork when present', () => {
    const unified = trackRowToUnifiedTrack({
      source: 'local',
      source_id: '/x.mp3',
      path: '/x.mp3',
      title: 'X',
      artists: JSON.stringify(['Y']),
      album: 'Z',
      duration_ms: 0,
      isrc: 'ABC',
      artwork_url: 'https://example.com/art.jpg',
      mtime: 0,
      created_at: 0,
    });
    expect(unified.album).toBe('Z');
    expect(unified.isrc).toBe('ABC');
    expect(unified.artwork).toBe('https://example.com/art.jpg');
  });
});

/**
 * Integration test for the 0002 migration itself — that's the only
 * place we exercise the actual chain (0001 → 0002) against legacy
 * rows. Lives here rather than in runner.test.ts because the SQL
 * under test is musaic-schema-specific.
 */
describe('0002 schema generalization', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  // The exact 0001_initial.sql, inlined. Pre-generalization shape:
  // local-only, path as PK, no source / source_id / artwork_url.
  const initial = {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE tracks (
        path        TEXT PRIMARY KEY NOT NULL,
        title       TEXT NOT NULL,
        artists     TEXT NOT NULL,
        album       TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        isrc        TEXT,
        mtime       INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `,
  };

  // The 0002 SQL, inlined (must stay in sync with the file).
  const generalize = {
    version: 2,
    name: 'generalize-tracks',
    sql: `
      CREATE TABLE tracks_new (
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

      INSERT INTO tracks_new
        (source, source_id, path, title, artists, album, duration_ms, isrc, artwork_url, mtime, created_at)
      SELECT
        'local', path, path, title, artists, album, duration_ms, isrc, NULL, mtime, created_at
      FROM tracks;

      DROP TABLE tracks;
      ALTER TABLE tracks_new RENAME TO tracks;
    `,
  };

  it('preserves existing local rows after generalize', () => {
    migrate(db, [initial]);
    // Pre-generalize: insert legacy-shape rows.
    db.prepare(
      `INSERT INTO tracks
         (path, title, artists, album, duration_ms, isrc, mtime, created_at)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '/legacy/a.mp3',
      'Legacy A',
      JSON.stringify(['Old Artist']),
      'Old Album',
      120_000,
      'USRC0000001',
      1_500_000_000,
      1_500_000_000,
    );
    db.prepare(
      `INSERT INTO tracks
         (path, title, artists, album, duration_ms, isrc, mtime, created_at)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('/legacy/b.mp3', 'Legacy B', JSON.stringify([]), null, 0, null, 1, 2);

    migrate(db, [initial, generalize]);

    // After: rows survived with source='local', source_id=path, path=path.
    const rows = getAllTracks(db);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.source_id === '/legacy/a.mp3');
    expect(a).toBeDefined();
    expect(a?.source).toBe('local');
    expect(a?.path).toBe('/legacy/a.mp3');
    expect(a?.title).toBe('Legacy A');
    expect(a?.artwork_url).toBeNull();
    expect(a?.created_at).toBe(1_500_000_000);
  });

  it('applies cleanly to an empty pre-generalize DB', () => {
    migrate(db, [initial, generalize]);
    expect(getAllTracks(db)).toEqual([]);
    // Schema is the new shape — youtube rows insert.
    upsertTrack(db, makeYouTubeRow());
    expect(getAllTracks(db)).toHaveLength(1);
  });

  it('user_version reaches 2 after the chain', () => {
    migrate(db, [initial, generalize]);
    const uv = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    expect(uv).toBe(2);
  });
});
