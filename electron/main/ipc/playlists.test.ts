/**
 * Handler-level tests for the playlist IPC surface.
 *
 * Strategy: mock `electron` so that importing this module doesn't
 * require an Electron binary (this file otherwise lands in the same
 * "can't run sandbox-side" bucket as system.test.ts). The mock
 * captures every `ipcMain.handle(channel, fn)` call so tests can
 * drive registered handlers directly with payloads.
 *
 * We test BOTH the named exported helpers (`handlePlaylistCreate`
 * etc., which take db + payload directly) and the registered
 * handlers (post-registration, with the captured map) — the helpers
 * cover the substantive logic, the registration test covers the
 * broadcast wiring.
 *
 * Scope per the slice prompt: happy path, validation rejection,
 * unknown-id rejection. The db helpers under these handlers have
 * their own much more thorough coverage; this file is the
 * boundary-layer coverage.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

// ----- electron mock (must precede import of ./playlists) -----

type CapturedHandler = (event: unknown, payload: unknown) => unknown;
const handlers = new Map<string, CapturedHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: CapturedHandler) => {
      handlers.set(channel, fn);
    },
  },
  // BrowserWindow.getAllWindows is only touched by
  // makeBroadcastPlaylistChanged; tests inject their own broadcaster
  // into registerPlaylistHandlers, so this stub just needs to exist.
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

// Imports MUST follow the vi.mock declaration above.
import { migrate } from '../db/runner';
import { upsertTrack } from '../db/tracks';
import { createPlaylist } from '../db/playlists';
import {
  handlePlaylistAddTracks,
  handlePlaylistCreate,
  handlePlaylistDelete,
  handlePlaylistGet,
  handlePlaylistList,
  handlePlaylistRemoveTracks,
  handlePlaylistRename,
  handlePlaylistReorder,
  registerPlaylistHandlers,
} from './playlists';

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
  `,
};

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, [schemaMigration]);
  return db;
}

function seedTrack(db: DatabaseSync, sourceId: string): void {
  upsertTrack(db, {
    source: 'local',
    source_id: sourceId,
    path: sourceId,
    title: 'T',
    artists: JSON.stringify(['A']),
    album: null,
    duration_ms: 0,
    isrc: null,
    artwork_url: null,
    mtime: 1,
    created_at: 1,
  });
}

describe('per-channel handler functions', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  // --- create -----------------------------------------------------------

  it('handlePlaylistCreate happy path returns the created variant', async () => {
    const result = await handlePlaylistCreate(db, { name: 'my-playlist' });
    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      expect(result.playlist.name).toBe('my-playlist');
      expect(result.playlist.id).toBeGreaterThan(0);
    }
  });

  it('handlePlaylistCreate translates empty-name validation to typed variant', async () => {
    const result = await handlePlaylistCreate(db, { name: '   ' });
    expect(result.kind).toBe('invalid-name');
    if (result.kind === 'invalid-name') expect(result.reason).toBe('empty');
  });

  it('handlePlaylistCreate translates too-long name to typed variant', async () => {
    const result = await handlePlaylistCreate(db, {
      name: 'a'.repeat(300),
    });
    expect(result.kind).toBe('invalid-name');
    if (result.kind === 'invalid-name') expect(result.reason).toBe('too-long');
  });

  it('handlePlaylistCreate rejects a Zod-malformed payload', async () => {
    await expect(handlePlaylistCreate(db, { name: 42 })).rejects.toThrow();
    await expect(handlePlaylistCreate(db, null)).rejects.toThrow();
  });

  // --- rename -----------------------------------------------------------

  it('handlePlaylistRename happy path returns the renamed variant', async () => {
    const pl = createPlaylist(db, 'orig');
    const result = await handlePlaylistRename(db, { id: pl.id, name: 'new' });
    expect(result.kind).toBe('renamed');
    if (result.kind === 'renamed') expect(result.playlist.name).toBe('new');
  });

  it('handlePlaylistRename translates validation to typed variant', async () => {
    const pl = createPlaylist(db, 'orig');
    const result = await handlePlaylistRename(db, { id: pl.id, name: '' });
    expect(result.kind).toBe('invalid-name');
  });

  it('handlePlaylistRename rejects unknown id (not a typed variant)', async () => {
    await expect(
      handlePlaylistRename(db, { id: 99999, name: 'whatever' }),
    ).rejects.toThrow(/playlist not found/);
  });

  // --- delete -----------------------------------------------------------

  it('handlePlaylistDelete removes the row', async () => {
    const pl = createPlaylist(db, 'gone');
    await handlePlaylistDelete(db, { id: pl.id });
    const list = await handlePlaylistList(db);
    expect(list.find((p) => p.id === pl.id)).toBeUndefined();
  });

  it('handlePlaylistDelete is idempotent for unknown id (no throw)', async () => {
    await expect(
      handlePlaylistDelete(db, { id: 99999 }),
    ).resolves.toBeUndefined();
  });

  // --- list / get -------------------------------------------------------

  it('handlePlaylistList returns the playlists with trackCount', async () => {
    seedTrack(db, '/a.mp3');
    const pl = createPlaylist(db, 'p');
    await handlePlaylistAddTracks(db, {
      id: pl.id,
      tracks: [{ source: 'local', sourceId: '/a.mp3' }],
    });
    const list = await handlePlaylistList(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.trackCount).toBe(1);
  });

  it('handlePlaylistGet returns null for unknown id', async () => {
    const result = await handlePlaylistGet(db, { id: 99999 });
    expect(result).toBeNull();
  });

  it('handlePlaylistGet returns a detail with ordered tracks', async () => {
    seedTrack(db, '/a.mp3');
    seedTrack(db, '/b.mp3');
    const pl = createPlaylist(db, 'p');
    await handlePlaylistAddTracks(db, {
      id: pl.id,
      tracks: [
        { source: 'local', sourceId: '/a.mp3' },
        { source: 'local', sourceId: '/b.mp3' },
      ],
    });
    const result = await handlePlaylistGet(db, { id: pl.id });
    expect(result).not.toBeNull();
    expect(result!.tracks.map((t) => t.position)).toEqual([0, 1]);
  });

  // --- add-tracks ------------------------------------------------------

  it('handlePlaylistAddTracks counts added vs skipped', async () => {
    seedTrack(db, '/a.mp3');
    const pl = createPlaylist(db, 'p');
    const result = await handlePlaylistAddTracks(db, {
      id: pl.id,
      tracks: [
        { source: 'local', sourceId: '/a.mp3' },
        { source: 'local', sourceId: '/nonexistent.mp3' },
      ],
    });
    expect(result).toEqual({ added: 1, skipped: 1 });
  });

  it('handlePlaylistAddTracks rejects unknown playlist id', async () => {
    seedTrack(db, '/a.mp3');
    await expect(
      handlePlaylistAddTracks(db, {
        id: 99999,
        tracks: [{ source: 'local', sourceId: '/a.mp3' }],
      }),
    ).rejects.toThrow(/playlist not found/);
  });

  // --- remove-tracks ---------------------------------------------------

  it('handlePlaylistRemoveTracks removes by membership id', async () => {
    seedTrack(db, '/a.mp3');
    const pl = createPlaylist(db, 'p');
    await handlePlaylistAddTracks(db, {
      id: pl.id,
      tracks: [{ source: 'local', sourceId: '/a.mp3' }],
    });
    const detail = await handlePlaylistGet(db, { id: pl.id });
    const ptId = detail!.tracks[0]!.playlistTrackId;
    const result = await handlePlaylistRemoveTracks(db, {
      id: pl.id,
      playlistTrackIds: [ptId],
    });
    expect(result.removed).toBe(1);
  });

  it('handlePlaylistRemoveTracks rejects unknown playlist id', async () => {
    await expect(
      handlePlaylistRemoveTracks(db, {
        id: 99999,
        playlistTrackIds: [1],
      }),
    ).rejects.toThrow(/playlist not found/);
  });

  // --- reorder ---------------------------------------------------------

  it('handlePlaylistReorder rearranges positions', async () => {
    seedTrack(db, '/a.mp3');
    seedTrack(db, '/b.mp3');
    const pl = createPlaylist(db, 'p');
    await handlePlaylistAddTracks(db, {
      id: pl.id,
      tracks: [
        { source: 'local', sourceId: '/a.mp3' },
        { source: 'local', sourceId: '/b.mp3' },
      ],
    });
    const detail = await handlePlaylistGet(db, { id: pl.id });
    const ids = detail!.tracks.map((t) => t.playlistTrackId);
    await handlePlaylistReorder(db, {
      id: pl.id,
      orderedPlaylistTrackIds: [...ids].reverse(),
    });
    const after = await handlePlaylistGet(db, { id: pl.id });
    expect(after!.tracks[0]?.track.sourceId).toBe('/b.mp3');
    expect(after!.tracks[1]?.track.sourceId).toBe('/a.mp3');
  });

  it('handlePlaylistReorder rejects mismatched id set', async () => {
    seedTrack(db, '/a.mp3');
    const pl = createPlaylist(db, 'p');
    await handlePlaylistAddTracks(db, {
      id: pl.id,
      tracks: [{ source: 'local', sourceId: '/a.mp3' }],
    });
    await expect(
      handlePlaylistReorder(db, {
        id: pl.id,
        orderedPlaylistTrackIds: [99999],
      }),
    ).rejects.toThrow(/not a member of playlist/);
  });
});

describe('registerPlaylistHandlers — broadcast wiring', () => {
  let db: DatabaseSync;
  let broadcast: Mock<() => void>;

  beforeEach(() => {
    handlers.clear();
    db = freshDb();
    broadcast = vi.fn();
    registerPlaylistHandlers(db, broadcast);
  });
  afterEach(() => {
    db.close();
  });

  // Helper to invoke a captured handler with a payload, returning
  // its result. The first arg passed to ipcMain.handle's callback
  // is an IpcMainInvokeEvent we don't care about — pass `null` and
  // ignore.
  const invoke = (channel: string, payload: unknown): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler registered for ${channel}`);
    return Promise.resolve(fn(null, payload));
  };

  it('registers all eight handlers', () => {
    const channels = [
      'playlist:create',
      'playlist:rename',
      'playlist:delete',
      'playlist:list',
      'playlist:get',
      'playlist:add-tracks',
      'playlist:remove-tracks',
      'playlist:reorder',
    ];
    for (const c of channels) {
      expect(handlers.has(c)).toBe(true);
    }
  });

  it('create broadcasts on success', async () => {
    await invoke('playlist:create', { name: 'p' });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('create does NOT broadcast on validation failure', async () => {
    await invoke('playlist:create', { name: '' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rename broadcasts on success only', async () => {
    const created = (await invoke('playlist:create', { name: 'p' })) as {
      kind: 'created';
      playlist: { id: number };
    };
    broadcast.mockClear();
    await invoke('playlist:rename', {
      id: created.playlist.id,
      name: 'p2',
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    broadcast.mockClear();
    await invoke('playlist:rename', {
      id: created.playlist.id,
      name: '',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('delete always broadcasts (idempotent invocation)', async () => {
    await invoke('playlist:delete', { id: 99999 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('list does not broadcast', async () => {
    await invoke('playlist:list', undefined);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('add-tracks broadcasts when added>0 but not when all skipped', async () => {
    seedTrack(db, '/a.mp3');
    const created = (await invoke('playlist:create', { name: 'p' })) as {
      kind: 'created';
      playlist: { id: number };
    };
    broadcast.mockClear();
    await invoke('playlist:add-tracks', {
      id: created.playlist.id,
      tracks: [{ source: 'local', sourceId: '/a.mp3' }],
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    broadcast.mockClear();
    // All missing → 0 added; should NOT broadcast.
    await invoke('playlist:add-tracks', {
      id: created.playlist.id,
      tracks: [{ source: 'local', sourceId: '/nope.mp3' }],
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('remove-tracks broadcasts only when something was actually removed', async () => {
    seedTrack(db, '/a.mp3');
    const created = (await invoke('playlist:create', { name: 'p' })) as {
      kind: 'created';
      playlist: { id: number };
    };
    await invoke('playlist:add-tracks', {
      id: created.playlist.id,
      tracks: [{ source: 'local', sourceId: '/a.mp3' }],
    });
    const detail = (await invoke('playlist:get', {
      id: created.playlist.id,
    })) as { tracks: { playlistTrackId: number }[] };
    broadcast.mockClear();
    await invoke('playlist:remove-tracks', {
      id: created.playlist.id,
      playlistTrackIds: [detail.tracks[0]!.playlistTrackId],
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    broadcast.mockClear();
    // Now the playlist is empty; removing the same id is a no-op.
    await invoke('playlist:remove-tracks', {
      id: created.playlist.id,
      playlistTrackIds: [detail.tracks[0]!.playlistTrackId],
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reorder broadcasts on success', async () => {
    seedTrack(db, '/a.mp3');
    seedTrack(db, '/b.mp3');
    const created = (await invoke('playlist:create', { name: 'p' })) as {
      kind: 'created';
      playlist: { id: number };
    };
    await invoke('playlist:add-tracks', {
      id: created.playlist.id,
      tracks: [
        { source: 'local', sourceId: '/a.mp3' },
        { source: 'local', sourceId: '/b.mp3' },
      ],
    });
    const detail = (await invoke('playlist:get', {
      id: created.playlist.id,
    })) as { tracks: { playlistTrackId: number }[] };
    broadcast.mockClear();
    await invoke('playlist:reorder', {
      id: created.playlist.id,
      orderedPlaylistTrackIds: detail.tracks
        .map((t) => t.playlistTrackId)
        .reverse(),
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
