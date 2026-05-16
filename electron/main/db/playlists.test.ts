import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './runner';
import { upsertTrack } from './tracks';
import {
  PLAYLIST_NAME_MAX_LEN,
  PlaylistValidationError,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  renamePlaylist,
} from './playlists';

/**
 * Inline post-0005 schema fixture. Same pattern as tracks.test.ts:
 * the per-table tests don't care how we got here, only that the
 * shape is what 0005 produces. The migration chain itself is
 * covered by runner.test.ts.
 *
 * We materialize BOTH tables (tracks + playlists + playlist_tracks)
 * because some tests need to insert tracks first (FK targets for
 * playlist_tracks membership and the cascade-on-track-delete test).
 *
 * Note: PRAGMA foreign_keys = ON is set per-connection in the test
 * setup below (matching production's openDb). Without it the
 * cascades and the FK-rejects-unknown-id tests in
 * playlist_tracks.test.ts would silently pass when they shouldn't.
 */
const schemaMigration = {
  version: 1,
  name: 'initial_full',
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
    CREATE TABLE playlists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE playlist_tracks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id      INTEGER NOT NULL,
      track_source     TEXT NOT NULL,
      track_source_id  TEXT NOT NULL,
      position         INTEGER NOT NULL,
      added_at         INTEGER NOT NULL,
      FOREIGN KEY (playlist_id)
        REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_source, track_source_id)
        REFERENCES tracks(source, source_id) ON DELETE CASCADE,
      UNIQUE (playlist_id, position)
    );
    CREATE INDEX idx_playlist_tracks_playlist
      ON playlist_tracks (playlist_id, position);
    CREATE INDEX idx_playlist_tracks_track
      ON playlist_tracks (track_source, track_source_id);
  `,
};

function makeLocalTrackRow(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    source: 'local' as const,
    source_id: sourceId,
    path: sourceId,
    title: 'Sample',
    artists: JSON.stringify(['Artist']),
    album: null as string | null,
    duration_ms: 180_000,
    isrc: null as string | null,
    artwork_url: null as string | null,
    mtime: 1_700_000_000,
    created_at: 1_700_000_000,
    ...overrides,
  };
}

describe('playlists CRUD', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    // Mirror production's openDb pragmas. ON is required for the
    // ON DELETE CASCADE behavior the playlist_tracks.test exercises.
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('createPlaylist inserts a row and returns its id, name, timestamps', () => {
    const before = Date.now();
    const pl = createPlaylist(db, 'My First Playlist');
    const after = Date.now();
    expect(pl.id).toBeGreaterThan(0);
    expect(pl.name).toBe('My First Playlist');
    expect(pl.createdAt).toBeGreaterThanOrEqual(before);
    expect(pl.createdAt).toBeLessThanOrEqual(after);
    // Both timestamps set to the same value at insert time — the
    // contract says newly created playlists have created_at ===
    // updated_at; later edits diverge them.
    expect(pl.createdAt).toBe(pl.updatedAt);
  });

  it('createPlaylist trims the name', () => {
    const pl = createPlaylist(db, '   Padded Name   ');
    expect(pl.name).toBe('Padded Name');
  });

  it('createPlaylist rejects an empty name', () => {
    expect(() => createPlaylist(db, '')).toThrow(PlaylistValidationError);
    try {
      createPlaylist(db, '');
    } catch (e) {
      expect(e).toBeInstanceOf(PlaylistValidationError);
      expect((e as PlaylistValidationError).reason).toBe('empty');
    }
  });

  it('createPlaylist rejects a whitespace-only name', () => {
    expect(() => createPlaylist(db, '   ')).toThrow(PlaylistValidationError);
    try {
      createPlaylist(db, '\t\n  ');
    } catch (e) {
      expect((e as PlaylistValidationError).reason).toBe('empty');
    }
  });

  it('createPlaylist accepts a 256-char name (boundary, inclusive)', () => {
    const pl = createPlaylist(db, 'a'.repeat(PLAYLIST_NAME_MAX_LEN));
    expect(pl.name.length).toBe(PLAYLIST_NAME_MAX_LEN);
  });

  it('createPlaylist rejects a 257-char name', () => {
    expect(() =>
      createPlaylist(db, 'a'.repeat(PLAYLIST_NAME_MAX_LEN + 1)),
    ).toThrow(PlaylistValidationError);
    try {
      createPlaylist(db, 'a'.repeat(PLAYLIST_NAME_MAX_LEN + 1));
    } catch (e) {
      expect((e as PlaylistValidationError).reason).toBe('too-long');
    }
  });

  it('createPlaylist length check is against trimmed name (256 spaces + 256 chars = OK)', () => {
    // Surrounding whitespace shouldn't count toward the limit. This
    // catches the easy off-by-one of validating before trim.
    const padded = ' '.repeat(50) + 'a'.repeat(PLAYLIST_NAME_MAX_LEN) + ' '.repeat(50);
    const pl = createPlaylist(db, padded);
    expect(pl.name.length).toBe(PLAYLIST_NAME_MAX_LEN);
  });

  it('renamePlaylist updates name and bumps updated_at', async () => {
    const original = createPlaylist(db, 'Original');
    // Sleep 5ms to guarantee a clock tick — Date.now() resolution
    // on some platforms is millisecond, and the test's create→rename
    // sequence is fast enough to potentially land in the same ms.
    await new Promise((r) => setTimeout(r, 5));
    const renamed = renamePlaylist(db, original.id, 'Renamed');
    expect(renamed.name).toBe('Renamed');
    expect(renamed.createdAt).toBe(original.createdAt);
    expect(renamed.updatedAt).toBeGreaterThan(original.updatedAt);
  });

  it('renamePlaylist trims the name', () => {
    const pl = createPlaylist(db, 'A');
    const renamed = renamePlaylist(db, pl.id, '   B   ');
    expect(renamed.name).toBe('B');
  });

  it('renamePlaylist rejects an empty name', () => {
    const pl = createPlaylist(db, 'A');
    expect(() => renamePlaylist(db, pl.id, '   ')).toThrow(PlaylistValidationError);
    try {
      renamePlaylist(db, pl.id, '');
    } catch (e) {
      expect((e as PlaylistValidationError).reason).toBe('empty');
    }
  });

  it('renamePlaylist rejects an over-length name', () => {
    const pl = createPlaylist(db, 'A');
    expect(() =>
      renamePlaylist(db, pl.id, 'a'.repeat(PLAYLIST_NAME_MAX_LEN + 1)),
    ).toThrow(PlaylistValidationError);
  });

  it('renamePlaylist throws on unknown id', () => {
    expect(() => renamePlaylist(db, 99999, 'whatever')).toThrow(
      /playlist not found/,
    );
  });

  it('deletePlaylist removes the row and returns true', () => {
    const pl = createPlaylist(db, 'gone');
    expect(deletePlaylist(db, pl.id)).toBe(true);
    expect(getPlaylist(db, pl.id)).toBeNull();
  });

  it('deletePlaylist returns false for unknown id (idempotent)', () => {
    expect(deletePlaylist(db, 99999)).toBe(false);
  });

  it('deletePlaylist cascades to playlist_tracks rows', () => {
    // Insert a track and a playlist; manually wire one membership
    // row. Cascade on playlist delete should remove the membership.
    upsertTrack(db, makeLocalTrackRow('/a.mp3'));
    const pl = createPlaylist(db, 'with-track');
    db.prepare(
      `INSERT INTO playlist_tracks
        (playlist_id, track_source, track_source_id, position, added_at)
       VALUES (?, 'local', '/a.mp3', 0, ?)`,
    ).run(pl.id, Date.now());
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id = ?')
          .get(pl.id) as { c: number }
      ).c,
    ).toBe(1);

    deletePlaylist(db, pl.id);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id = ?')
          .get(pl.id) as { c: number }
      ).c,
    ).toBe(0);
  });
});

describe('listPlaylists', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('returns an empty array when no playlists exist', () => {
    expect(listPlaylists(db)).toEqual([]);
  });

  it('returns playlists with trackCount = 0 for empty ones', () => {
    createPlaylist(db, 'empty');
    const list = listPlaylists(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.trackCount).toBe(0);
  });

  it('counts memberships across multiple playlists', () => {
    upsertTrack(db, makeLocalTrackRow('/a.mp3'));
    upsertTrack(db, makeLocalTrackRow('/b.mp3'));
    const p1 = createPlaylist(db, 'two-tracks');
    const p2 = createPlaylist(db, 'one-track');
    const insertPt = db.prepare(
      `INSERT INTO playlist_tracks
        (playlist_id, track_source, track_source_id, position, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertPt.run(p1.id, 'local', '/a.mp3', 0, Date.now());
    insertPt.run(p1.id, 'local', '/b.mp3', 1, Date.now());
    insertPt.run(p2.id, 'local', '/a.mp3', 0, Date.now());

    const list = listPlaylists(db);
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get(p1.id)?.trackCount).toBe(2);
    expect(byId.get(p2.id)?.trackCount).toBe(1);
  });

  it('orders by updated_at DESC (most recently touched first)', async () => {
    const oldest = createPlaylist(db, 'oldest');
    await new Promise((r) => setTimeout(r, 5));
    const middle = createPlaylist(db, 'middle');
    await new Promise((r) => setTimeout(r, 5));
    const newest = createPlaylist(db, 'newest');

    const list = listPlaylists(db);
    expect(list.map((p) => p.id)).toEqual([newest.id, middle.id, oldest.id]);

    // Bump the oldest by renaming it; should jump to the top.
    await new Promise((r) => setTimeout(r, 5));
    renamePlaylist(db, oldest.id, 'oldest renamed');
    const list2 = listPlaylists(db);
    expect(list2[0]?.id).toBe(oldest.id);
  });
});

describe('getPlaylist', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('returns null for an unknown id', () => {
    expect(getPlaylist(db, 99999)).toBeNull();
  });

  it('returns header + empty tracks for an empty playlist', () => {
    const pl = createPlaylist(db, 'empty');
    const detail = getPlaylist(db, pl.id);
    expect(detail).not.toBeNull();
    expect(detail?.name).toBe('empty');
    expect(detail?.tracks).toEqual([]);
  });

  it('returns tracks in position order with full LibraryTrack shape', () => {
    upsertTrack(
      db,
      makeLocalTrackRow('/song1.mp3', { title: 'Song One' }),
    );
    upsertTrack(
      db,
      makeLocalTrackRow('/song2.mp3', { title: 'Song Two' }),
    );
    const pl = createPlaylist(db, 'two');
    const insertPt = db.prepare(
      `INSERT INTO playlist_tracks
        (playlist_id, track_source, track_source_id, position, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Insert in non-position order to prove the ORDER BY is doing
    // the work — not the insert sequence.
    insertPt.run(pl.id, 'local', '/song2.mp3', 1, Date.now());
    insertPt.run(pl.id, 'local', '/song1.mp3', 0, Date.now());

    const detail = getPlaylist(db, pl.id);
    expect(detail).not.toBeNull();
    expect(detail!.tracks).toHaveLength(2);
    expect(detail!.tracks[0]?.position).toBe(0);
    expect(detail!.tracks[0]?.track.title).toBe('Song One');
    expect(detail!.tracks[0]?.track.id).toBe('local:/song1.mp3');
    expect(detail!.tracks[1]?.position).toBe(1);
    expect(detail!.tracks[1]?.track.title).toBe('Song Two');
    // playlistTrackId is the surrogate PK; must be a positive int.
    expect(detail!.tracks[0]?.playlistTrackId).toBeGreaterThan(0);
    expect(detail!.tracks[1]?.playlistTrackId).toBeGreaterThan(0);
    expect(detail!.tracks[0]?.playlistTrackId).not.toBe(
      detail!.tracks[1]?.playlistTrackId,
    );
  });
});
