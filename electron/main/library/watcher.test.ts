/**
 * Tests for the watcher's reconciliation logic.
 *
 * The chokidar half is not unit-tested here — it sits at the
 * fs-event boundary that Vitest can't reach cleanly. What
 * is testable is the pure-ish startup diff: given a folder on disk
 * and a SQLite index, which files get imported.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../db/runner';
import { getAllTracks, upsertTrack } from '../db/tracks';
import { reconcile } from './watcher';

vi.mock('music-metadata', () => ({
  parseFile: vi.fn(),
}));
import { parseFile, type IAudioMetadata } from 'music-metadata';
const mockParseFile = vi.mocked(parseFile);

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

function fakeMetadata(
  common: Record<string, unknown> = {},
  format: Record<string, unknown> = {},
): IAudioMetadata {
  return {
    common: {
      artists: ['Reconcile Artist'],
      title: 'Reconcile Title',
      album: 'Reconcile Album',
      isrc: ['MOCKISRC'],
      ...common,
    },
    format: { duration: 90.0, ...format },
  } as unknown as IAudioMetadata;
}

function makeIndexedRow(filePath: string) {
  return {
    source: 'local' as const,
    source_id: filePath,
    path: filePath,
    title: 'Already Indexed',
    artists: JSON.stringify(['Old Artist']),
    album: null as string | null,
    duration_ms: 60_000,
    isrc: null as string | null,
    artwork_url: null as string | null,
    mtime: 1_000,
    created_at: 1_000,
  };
}

describe('reconcile', () => {
  let folder: string;
  let db: DatabaseSync;

  // beforeEach is async deliberately — same vitest 2.x rejection-
  // tracking quirk documented in import.test.ts.
  beforeEach(async () => {
    mockParseFile.mockReset();
    mockParseFile.mockResolvedValue(fakeMetadata());
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'musaic-watcher-'));
    db = new DatabaseSync(':memory:');
    migrate(db, [initialMigration]);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('imports files that are on disk but not in the index', async () => {
    await fs.writeFile(path.join(folder, 'new-one.mp3'), 'x');
    await fs.writeFile(path.join(folder, 'new-two.mp3'), 'y');

    const result = await reconcile(folder, db);

    expect(result).toEqual({ imported: 2, failed: 0 });
    const paths = getAllTracks(db).map((r) => r.path).sort();
    expect(paths).toEqual([
      path.join(folder, 'new-one.mp3'),
      path.join(folder, 'new-two.mp3'),
    ]);
  });

  it('does not re-import files already in the index', async () => {
    const existing = path.join(folder, 'old.mp3');
    await fs.writeFile(existing, 'x');
    upsertTrack(db, makeIndexedRow(existing));

    const result = await reconcile(folder, db);

    expect(result.imported).toBe(0);
    // music-metadata never gets called for indexed files. Important —
    // the whole point of reconciliation (vs `ignoreInitial: false`)
    // is to skip the work for files we already know about.
    expect(mockParseFile).not.toHaveBeenCalled();
    // The old row's title isn't overwritten.
    expect(getAllTracks(db)[0]?.title).toBe('Already Indexed');
  });

  it('imports the new file and leaves the existing one alone in the mixed case', async () => {
    const old = path.join(folder, 'old.mp3');
    const newOne = path.join(folder, 'new.mp3');
    await fs.writeFile(old, 'x');
    await fs.writeFile(newOne, 'y');
    upsertTrack(db, makeIndexedRow(old));

    const result = await reconcile(folder, db);

    expect(result.imported).toBe(1);
    expect(mockParseFile).toHaveBeenCalledTimes(1);
    const paths = getAllTracks(db).map((r) => r.path).sort();
    expect(paths).toEqual([newOne, old]);
  });

  it('walks subdirectories recursively', async () => {
    await fs.mkdir(path.join(folder, 'Artists', 'Boards of Canada'), {
      recursive: true,
    });
    const nested = path.join(
      folder,
      'Artists',
      'Boards of Canada',
      'roygbiv.mp3',
    );
    await fs.writeFile(nested, 'x');

    const result = await reconcile(folder, db);

    expect(result.imported).toBe(1);
    expect(getAllTracks(db).map((r) => r.path)).toEqual([nested]);
  });

  it('skips non-playable files and hidden entries', async () => {
    await fs.writeFile(path.join(folder, 'song.mp3'), 'x');
    await fs.writeFile(path.join(folder, 'cover.jpg'), 'image');
    await fs.writeFile(path.join(folder, 'notes.txt'), 'text');
    await fs.writeFile(path.join(folder, '.DS_Store'), 'mac');
    // A hidden subdirectory's contents are also skipped — `.musaic/`
    // is a plausible future home for sidecar files we don't index.
    await fs.mkdir(path.join(folder, '.musaic'));
    await fs.writeFile(path.join(folder, '.musaic', 'should-skip.mp3'), 'x');

    const result = await reconcile(folder, db);

    expect(result.imported).toBe(1);
    expect(getAllTracks(db).map((r) => r.path)).toEqual([
      path.join(folder, 'song.mp3'),
    ]);
  });

  it('continues after a single import failure', async () => {
    // First call: succeed. Second: throw. Order depends on readdir,
    // so don't assert exact pairing — assert the resilience.
    let calls = 0;
    mockParseFile.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('corrupt');
      return fakeMetadata();
    });

    await fs.writeFile(path.join(folder, 'a.mp3'), 'x');
    await fs.writeFile(path.join(folder, 'b.mp3'), 'y');

    const result = await reconcile(folder, db);

    expect(result.imported).toBe(1);
    expect(result.failed).toBe(1);
    expect(getAllTracks(db)).toHaveLength(1);
  });

  it('returns a zero-result on an empty folder', async () => {
    const result = await reconcile(folder, db);
    expect(result).toEqual({ imported: 0, failed: 0 });
    expect(getAllTracks(db)).toHaveLength(0);
  });
});
