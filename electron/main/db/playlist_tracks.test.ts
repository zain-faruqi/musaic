import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './runner';
import { createPlaylist, getPlaylist } from './playlists';
import { deleteTrack, upsertTrack } from './tracks';
import {
  addTracks,
  removeTracks,
  reorderTracks,
} from './playlist_tracks';

/**
 * Inline post-0005 schema fixture, same shape as in
 * playlists.test.ts. (See the rationale comment there for why
 * each per-table file uses an inline fixture rather than chaining
 * the real migrations.)
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
    title: `t-${sourceId}`,
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

/**
 * Helper: insert N tracks with sequential paths, return their refs.
 */
function seedTracks(db: DatabaseSync, n: number): { source: 'local'; sourceId: string }[] {
  const refs: { source: 'local'; sourceId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const sourceId = `/track-${i}.mp3`;
    upsertTrack(db, makeLocalTrackRow(sourceId));
    refs.push({ source: 'local', sourceId });
  }
  return refs;
}

describe('addTracks', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('appends tracks at end of playlist, returns added count', () => {
    const refs = seedTracks(db, 3);
    const pl = createPlaylist(db, 'p');
    const result = addTracks(db, pl.id, refs);
    expect(result).toEqual({ added: 3, skipped: 0 });

    const detail = getPlaylist(db, pl.id);
    expect(detail?.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(detail?.tracks.map((t) => t.track.sourceId)).toEqual([
      '/track-0.mp3',
      '/track-1.mp3',
      '/track-2.mp3',
    ]);
  });

  it('preserves input order when appending', () => {
    const refs = seedTracks(db, 3);
    const pl = createPlaylist(db, 'p');
    // Append in reversed order; the playlist's order should match
    // the input array, not the natural sort.
    addTracks(db, pl.id, [...refs].reverse());

    const detail = getPlaylist(db, pl.id);
    expect(detail?.tracks.map((t) => t.track.sourceId)).toEqual([
      '/track-2.mp3',
      '/track-1.mp3',
      '/track-0.mp3',
    ]);
  });

  it('subsequent calls continue position numbering from end', () => {
    const refs = seedTracks(db, 4);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs.slice(0, 2));
    addTracks(db, pl.id, refs.slice(2, 4));

    const detail = getPlaylist(db, pl.id);
    expect(detail?.tracks.map((t) => t.position)).toEqual([0, 1, 2, 3]);
  });

  it('skips refs whose track is not in the tracks table, counts them', () => {
    const refs = seedTracks(db, 2);
    const pl = createPlaylist(db, 'p');
    const result = addTracks(db, pl.id, [
      refs[0]!,
      { source: 'local', sourceId: '/nonexistent.mp3' },
      refs[1]!,
    ]);
    expect(result).toEqual({ added: 2, skipped: 1 });
    // The skip doesn't leave a position gap — the second valid
    // ref lands at position 1, not 2.
    const detail = getPlaylist(db, pl.id);
    expect(detail?.tracks.map((t) => t.position)).toEqual([0, 1]);
  });

  it('allows duplicate tracks within a playlist', () => {
    const refs = seedTracks(db, 1);
    const pl = createPlaylist(db, 'p');
    const result = addTracks(db, pl.id, [refs[0]!, refs[0]!, refs[0]!]);
    expect(result).toEqual({ added: 3, skipped: 0 });
    const detail = getPlaylist(db, pl.id);
    expect(detail?.tracks).toHaveLength(3);
    expect(detail?.tracks.map((t) => t.track.sourceId)).toEqual([
      '/track-0.mp3',
      '/track-0.mp3',
      '/track-0.mp3',
    ]);
  });

  it('throws on an empty-input call with a nonexistent playlist (no silent no-op)', () => {
    expect(() => addTracks(db, 99999, [])).toThrow(/playlist not found/);
  });

  it('throws when the playlist does not exist', () => {
    const refs = seedTracks(db, 1);
    expect(() => addTracks(db, 99999, refs)).toThrow(/playlist not found/);
  });

  it("bumps the parent playlist's updated_at", async () => {
    const refs = seedTracks(db, 1);
    const pl = createPlaylist(db, 'p');
    await new Promise((r) => setTimeout(r, 5));
    addTracks(db, pl.id, refs);
    const after = getPlaylist(db, pl.id);
    expect(after?.updatedAt).toBeGreaterThan(pl.updatedAt);
  });

  it('UNIQUE(playlist_id, position) is enforced by a direct duplicate insert', () => {
    const refs = seedTracks(db, 1);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    // Direct insert at the same position should be rejected.
    expect(() => {
      db.prepare(
        `INSERT INTO playlist_tracks
          (playlist_id, track_source, track_source_id, position, added_at)
         VALUES (?, 'local', '/track-0.mp3', 0, ?)`,
      ).run(pl.id, Date.now());
    }).toThrow(/UNIQUE/);
  });

  it('FK rejects a direct insert against a nonexistent playlist', () => {
    // Sanity check that PRAGMA foreign_keys = ON is doing its job in
    // this test connection. Without the pragma, the orphan insert
    // would succeed silently — the cascade tests below would too,
    // which would be a false green.
    const refs = seedTracks(db, 1);
    expect(() => {
      db.prepare(
        `INSERT INTO playlist_tracks
          (playlist_id, track_source, track_source_id, position, added_at)
         VALUES (99999, ?, ?, 0, ?)`,
      ).run(refs[0]!.source, refs[0]!.sourceId, Date.now());
    }).toThrow(/FOREIGN KEY/);
  });

  it('deleting a track cascades to its playlist_tracks rows', () => {
    // The watcher's `unlink` shape, surfaced as a unit test.
    const refs = seedTracks(db, 2);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);

    // Delete the first track from `tracks`. Cascade should remove
    // its membership row; the playlist row itself stays.
    deleteTrack(db, refs[0]!.source, refs[0]!.sourceId);

    const detail = getPlaylist(db, pl.id);
    expect(detail).not.toBeNull();
    // Position numbering remains as-is for the survivor (1) — the
    // dense-int invariant is the addTracks/removeTracks/reorderTracks
    // surface's job, not the cascade's. A FK cascade is the right
    // shape for "this track no longer exists anywhere", but it
    // leaves the surviving playlist_tracks rows untouched. UI
    // surfaces never see this directly because getPlaylist orders
    // by position and shows what survived; the gap is invisible
    // unless you read positions directly.
    expect(detail?.tracks).toHaveLength(1);
    expect(detail?.tracks[0]?.track.sourceId).toBe('/track-1.mp3');
  });
});

describe('removeTracks', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('removes by membership id and renumbers to close gaps', () => {
    const refs = seedTracks(db, 5);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const detail = getPlaylist(db, pl.id)!;
    const idAtPos1 = detail.tracks[1]!.playlistTrackId;
    const idAtPos3 = detail.tracks[3]!.playlistTrackId;

    const result = removeTracks(db, pl.id, [idAtPos1, idAtPos3]);
    expect(result).toEqual({ removed: 2 });

    const after = getPlaylist(db, pl.id)!;
    // Dense renumber: 3 survivors at positions 0, 1, 2.
    expect(after.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
    // Order is preserved: was [0, 1, 2, 3, 4] → kept [0, 2, 4].
    expect(after.tracks.map((t) => t.track.sourceId)).toEqual([
      '/track-0.mp3',
      '/track-2.mp3',
      '/track-4.mp3',
    ]);
  });

  it('removing the only track leaves an empty playlist', () => {
    const refs = seedTracks(db, 1);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const detail = getPlaylist(db, pl.id)!;
    removeTracks(db, pl.id, [detail.tracks[0]!.playlistTrackId]);
    expect(getPlaylist(db, pl.id)?.tracks).toEqual([]);
  });

  it('ignores ids that do not belong to this playlist', () => {
    const refs = seedTracks(db, 1);
    const p1 = createPlaylist(db, 'p1');
    const p2 = createPlaylist(db, 'p2');
    addTracks(db, p1.id, refs);
    addTracks(db, p2.id, refs);
    const p1Id = getPlaylist(db, p1.id)!.tracks[0]!.playlistTrackId;
    const p2Id = getPlaylist(db, p2.id)!.tracks[0]!.playlistTrackId;

    // Try to remove p1's id while scoped to p2 — should be a no-op.
    const result = removeTracks(db, p2.id, [p1Id]);
    expect(result.removed).toBe(0);
    expect(getPlaylist(db, p1.id)?.tracks).toHaveLength(1);
    expect(getPlaylist(db, p2.id)?.tracks).toHaveLength(1);
    // And removing p2's actual id works.
    expect(removeTracks(db, p2.id, [p2Id]).removed).toBe(1);
  });

  it('empty input is a no-op', () => {
    const refs = seedTracks(db, 2);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const before = getPlaylist(db, pl.id)!;
    const result = removeTracks(db, pl.id, []);
    expect(result.removed).toBe(0);
    const after = getPlaylist(db, pl.id)!;
    // updated_at should be unchanged on a true no-op — empty
    // input shouldn't bump the touch timestamp.
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("bumps the parent playlist's updated_at on a real removal", async () => {
    const refs = seedTracks(db, 2);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const before = getPlaylist(db, pl.id)!;
    await new Promise((r) => setTimeout(r, 5));
    removeTracks(db, pl.id, [before.tracks[0]!.playlistTrackId]);
    const after = getPlaylist(db, pl.id)!;
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it('throws when the playlist does not exist', () => {
    expect(() => removeTracks(db, 99999, [1, 2])).toThrow(/playlist not found/);
  });
});

describe('reorderTracks', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('rearranges positions to match the input order', () => {
    const refs = seedTracks(db, 4);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const ids = getPlaylist(db, pl.id)!.tracks.map((t) => t.playlistTrackId);

    // Reverse the order.
    reorderTracks(db, pl.id, [...ids].reverse());

    const after = getPlaylist(db, pl.id)!;
    expect(after.tracks.map((t) => t.track.sourceId)).toEqual([
      '/track-3.mp3',
      '/track-2.mp3',
      '/track-1.mp3',
      '/track-0.mp3',
    ]);
    expect(after.tracks.map((t) => t.position)).toEqual([0, 1, 2, 3]);
  });

  it('a no-op reorder (same input as current) succeeds', () => {
    const refs = seedTracks(db, 3);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const ids = getPlaylist(db, pl.id)!.tracks.map((t) => t.playlistTrackId);

    expect(() => reorderTracks(db, pl.id, ids)).not.toThrow();
    const after = getPlaylist(db, pl.id)!;
    expect(after.tracks.map((t) => t.playlistTrackId)).toEqual(ids);
    expect(after.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it('throws when input length does not match playlist size', () => {
    const refs = seedTracks(db, 3);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const ids = getPlaylist(db, pl.id)!.tracks.map((t) => t.playlistTrackId);

    expect(() => reorderTracks(db, pl.id, ids.slice(0, 2))).toThrow(
      /input length/,
    );
    // Verify no partial mutation.
    expect(
      getPlaylist(db, pl.id)!.tracks.map((t) => t.position),
    ).toEqual([0, 1, 2]);
  });

  it('throws when input contains duplicate ids', () => {
    const refs = seedTracks(db, 3);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const ids = getPlaylist(db, pl.id)!.tracks.map((t) => t.playlistTrackId);

    expect(() =>
      reorderTracks(db, pl.id, [ids[0]!, ids[0]!, ids[1]!]),
    ).toThrow(/duplicate ids/);
  });

  it('throws when input contains an id that is not a member of the playlist', () => {
    const refs = seedTracks(db, 3);
    const p1 = createPlaylist(db, 'p1');
    const p2 = createPlaylist(db, 'p2');
    addTracks(db, p1.id, refs);
    addTracks(db, p2.id, refs);
    const p1Ids = getPlaylist(db, p1.id)!.tracks.map((t) => t.playlistTrackId);
    const p2Ids = getPlaylist(db, p2.id)!.tracks.map((t) => t.playlistTrackId);

    // Inputs that are valid count but contain a foreign id.
    expect(() =>
      reorderTracks(db, p1.id, [p1Ids[0]!, p1Ids[1]!, p2Ids[0]!]),
    ).toThrow(/is not a member of playlist/);
  });

  it("bumps the parent playlist's updated_at", async () => {
    const refs = seedTracks(db, 3);
    const pl = createPlaylist(db, 'p');
    addTracks(db, pl.id, refs);
    const before = getPlaylist(db, pl.id)!;
    const ids = before.tracks.map((t) => t.playlistTrackId);
    await new Promise((r) => setTimeout(r, 5));
    reorderTracks(db, pl.id, [...ids].reverse());
    const after = getPlaylist(db, pl.id)!;
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it('handles a large playlist (offset trick survives N=2000)', () => {
    // The reorder offset is 1_000_000. A playlist of N=2000 sits
    // far under it, so phase-1 positions (live + offset) and
    // phase-2 positions (0..N-1) never overlap. This test proves
    // the offset is large enough for any realistic personal-app
    // playlist size.
    const refs = seedTracks(db, 2000);
    const pl = createPlaylist(db, 'big');
    addTracks(db, pl.id, refs);
    const ids = getPlaylist(db, pl.id)!.tracks.map((t) => t.playlistTrackId);

    // Reverse: every row moves to a new position.
    expect(() =>
      reorderTracks(db, pl.id, [...ids].reverse()),
    ).not.toThrow();

    const after = getPlaylist(db, pl.id)!;
    expect(after.tracks).toHaveLength(2000);
    expect(after.tracks[0]?.position).toBe(0);
    expect(after.tracks[1999]?.position).toBe(1999);
    expect(after.tracks[0]?.track.sourceId).toBe('/track-1999.mp3');
    expect(after.tracks[1999]?.track.sourceId).toBe('/track-0.mp3');
  });

  it('throws when the playlist does not exist', () => {
    expect(() => reorderTracks(db, 99999, [])).toThrow(/playlist not found/);
  });
});
