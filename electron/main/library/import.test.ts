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
import { getTrack } from '../db/tracks';
import { importFile, scanMetadata } from './import';

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

function fakeMetadata(common: Record<string, unknown> = {}, format: Record<string, unknown> = {}) {
  return {
    common: { artists: ['Mock Artist'], title: 'Mock Title', album: 'Mock Album', isrc: ['MOCKISRC'], ...common },
    format: { duration: 180.5, ...format },
  } as unknown as IAudioMetadata;
}

describe('scanMetadata', () => {
  // beforeEach is async deliberately — vitest 2.x's unhandled-
  // rejection tracking gets confused when a sync beforeEach precedes
  // a test that awaits a rejected mock; the rejection is sometimes
  // surfaced as a test failure even after expect().rejects.toThrow()
  // has consumed it. Awaiting the reset moves the timing into a
  // microtask where vitest's tracking doesn't fire.
  beforeEach(async () => {
    mockParseFile.mockReset();
  });

  it('returns parsed fields when all tags are present', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata());
    const meta = await scanMetadata('/tmp/song.mp3');
    expect(meta).toEqual({
      title: 'Mock Title',
      artists: ['Mock Artist'],
      album: 'Mock Album',
      durationMs: 180_500,
      isrc: 'MOCKISRC',
    });
  });

  it('falls back to filename for missing title', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ title: undefined }));
    const meta = await scanMetadata('/tmp/Lonely Song.mp3');
    expect(meta.title).toBe('Lonely Song');
  });

  it('falls back to filename for empty/whitespace title', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ title: '   ' }));
    const meta = await scanMetadata('/tmp/Lonely Song.mp3');
    expect(meta.title).toBe('Lonely Song');
  });

  it('falls back to ["Unknown Artist"] for missing artists', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ artists: undefined }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.artists).toEqual(['Unknown Artist']);
  });

  it('falls back to ["Unknown Artist"] for empty artists array', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ artists: [] }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.artists).toEqual(['Unknown Artist']);
  });

  it('falls back to ["Unknown Artist"] when all entries are whitespace', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ artists: ['  ', ''] }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.artists).toEqual(['Unknown Artist']);
  });

  it('null album when missing', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ album: undefined }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.album).toBeNull();
  });

  it('durationMs of 0 when format.duration is missing', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({}, { duration: undefined }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.durationMs).toBe(0);
  });

  it('rounds duration to milliseconds', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({}, { duration: 12.3456 }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.durationMs).toBe(12_346);
  });

  it('null isrc when missing', async () => {
    mockParseFile.mockResolvedValue(fakeMetadata({ isrc: undefined }));
    const meta = await scanMetadata('/tmp/x.mp3');
    expect(meta.isrc).toBeNull();
  });

  it('throws when music-metadata throws', async () => {
    mockParseFile.mockImplementation(async () => {
      throw new Error('bad header');
    });
    await expect(scanMetadata('/tmp/x.mp3')).rejects.toThrow(
      /could not read metadata for x.mp3.*bad header/,
    );
  });
});

describe('importFile', () => {
  let folder: string;
  let elsewhere: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    mockParseFile.mockReset();
    mockParseFile.mockResolvedValue(fakeMetadata());
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'musaic-folder-'));
    elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'musaic-src-'));
    db = new DatabaseSync(':memory:');
    migrate(db, [initialMigration]);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it('copies the file into the Musaic folder and indexes it', async () => {
    const src = path.join(elsewhere, 'song.mp3');
    await fs.writeFile(src, 'fake-audio-bytes');

    const track = await importFile(src, folder, db);

    const target = path.join(folder, 'song.mp3');
    expect(await fs.readFile(target, 'utf8')).toBe('fake-audio-bytes');
    expect(await fs.readFile(src, 'utf8')).toBe('fake-audio-bytes');
    expect(getTrack(db, 'local', target)).toBeDefined();
    expect(track).toMatchObject({
      id: `local:${target}`,
      source: 'local',
      sourceId: target,
      title: 'Mock Title',
      artists: ['Mock Artist'],
      album: 'Mock Album',
      durationMs: 180_500,
      isrc: 'MOCKISRC',
    });
  });

  it('skips the copy when the source is already inside the folder', async () => {
    const src = path.join(folder, 'already-here.mp3');
    await fs.writeFile(src, 'fake');

    const track = await importFile(src, folder, db);

    const entries = await fs.readdir(folder);
    expect(entries).toEqual(['already-here.mp3']);
    expect(track.sourceId).toBe(src);
  });

  it('appends (1) on a name collision', async () => {
    await fs.writeFile(path.join(folder, 'song.mp3'), 'existing');
    const src = path.join(elsewhere, 'song.mp3');
    await fs.writeFile(src, 'incoming');

    const track = await importFile(src, folder, db);

    expect(track.sourceId).toBe(path.join(folder, 'song (1).mp3'));
    expect(await fs.readFile(path.join(folder, 'song.mp3'), 'utf8')).toBe(
      'existing',
    );
    expect(await fs.readFile(path.join(folder, 'song (1).mp3'), 'utf8')).toBe(
      'incoming',
    );
  });

  it('rejects unsupported extensions', async () => {
    const src = path.join(elsewhere, 'document.pdf');
    await fs.writeFile(src, 'pdf');
    await expect(importFile(src, folder, db)).rejects.toThrow(
      /unsupported file type/,
    );
    expect(await fs.readdir(folder)).toEqual([]);
  });

  it('rejects files with no extension', async () => {
    const src = path.join(elsewhere, 'noext');
    await fs.writeFile(src, 'data');
    await expect(importFile(src, folder, db)).rejects.toThrow(
      /unsupported file type/,
    );
  });

  it('does not copy the file if metadata parsing fails', async () => {
    mockParseFile.mockImplementation(async () => {
      throw new Error('corrupt');
    });
    const src = path.join(elsewhere, 'broken.mp3');
    await fs.writeFile(src, 'corrupted-bytes');

    await expect(importFile(src, folder, db)).rejects.toThrow(/corrupt/);

    expect(await fs.readdir(folder)).toEqual([]);
    expect(getTrack(db, 'local', path.join(folder, 'broken.mp3'))).toBeUndefined();
  });

  it('preserves created_at on re-import (upsert ON CONFLICT)', async () => {
    const src = path.join(elsewhere, 'song.mp3');
    await fs.writeFile(src, 'a');

    const t0 = Date.now();
    await importFile(src, folder, db);
    const target = path.join(folder, 'song.mp3');
    const first = getTrack(db, 'local', target);
    expect(first?.created_at).toBeGreaterThanOrEqual(t0);

    await new Promise((r) => setTimeout(r, 5));
    await importFile(target, folder, db);
    const second = getTrack(db, 'local', target);
    expect(second?.created_at).toBe(first?.created_at);
  });

  it('handles uppercase extensions consistently', async () => {
    const src = path.join(elsewhere, 'YELL.MP3');
    await fs.writeFile(src, 'x');
    mockParseFile.mockResolvedValue(fakeMetadata());
    const track = await importFile(src, folder, db);
    expect(track.title).toBe('Mock Title');
  });
});
