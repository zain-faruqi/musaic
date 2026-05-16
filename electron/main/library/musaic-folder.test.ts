import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureMusaicFolder,
  isInsideMusaicFolder,
  resolveImportTarget,
} from './musaic-folder';

describe('isInsideMusaicFolder', () => {
  const folder = '/Users/x/Music/Musaic';

  it('returns true for files directly inside', () => {
    expect(isInsideMusaicFolder(`${folder}/song.mp3`, folder)).toBe(true);
  });

  it('returns true for files in subdirectories', () => {
    expect(isInsideMusaicFolder(`${folder}/Albums/A/song.mp3`, folder)).toBe(
      true,
    );
  });

  it('returns true for the folder itself', () => {
    expect(isInsideMusaicFolder(folder, folder)).toBe(true);
  });

  it('returns false for siblings that share a name prefix', () => {
    expect(isInsideMusaicFolder('/Users/x/Music/Musaic2/song.mp3', folder)).toBe(
      false,
    );
  });

  it('returns false for ancestor paths', () => {
    expect(isInsideMusaicFolder('/Users/x/Music/song.mp3', folder)).toBe(false);
  });

  it('returns false for unrelated paths', () => {
    expect(isInsideMusaicFolder('/tmp/song.mp3', folder)).toBe(false);
  });
});

describe('ensureMusaicFolder', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'musaic-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates the folder if missing', async () => {
    const target = path.join(tmp, 'Musaic');
    await ensureMusaicFolder(target);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is a no-op if the folder exists', async () => {
    const target = path.join(tmp, 'Musaic');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'sentinel'), 'hi');
    await ensureMusaicFolder(target);
    const contents = await fs.readFile(path.join(target, 'sentinel'), 'utf8');
    expect(contents).toBe('hi');
  });

  it('creates intermediate parents (recursive mkdir)', async () => {
    const target = path.join(tmp, 'a', 'b', 'Musaic');
    await ensureMusaicFolder(target);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('resolveImportTarget', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'musaic-test-'));
  });
  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('returns srcPath unchanged when src is already inside the folder', async () => {
    const src = path.join(folder, 'already-here.mp3');
    await fs.writeFile(src, 'x');
    const target = await resolveImportTarget(src, folder);
    expect(target).toBe(src);
  });

  it('returns folder/basename when no collision', async () => {
    const src = '/tmp/elsewhere/song.mp3';
    const target = await resolveImportTarget(src, folder);
    expect(target).toBe(path.join(folder, 'song.mp3'));
  });

  it('appends (1) on the first collision', async () => {
    await fs.writeFile(path.join(folder, 'song.mp3'), '');
    const target = await resolveImportTarget('/tmp/elsewhere/song.mp3', folder);
    expect(target).toBe(path.join(folder, 'song (1).mp3'));
  });

  it('keeps incrementing through multiple collisions', async () => {
    await fs.writeFile(path.join(folder, 'song.mp3'), '');
    await fs.writeFile(path.join(folder, 'song (1).mp3'), '');
    await fs.writeFile(path.join(folder, 'song (2).mp3'), '');
    const target = await resolveImportTarget('/tmp/elsewhere/song.mp3', folder);
    expect(target).toBe(path.join(folder, 'song (3).mp3'));
  });

  it('preserves the file extension on collision', async () => {
    await fs.writeFile(path.join(folder, 'tune.flac'), '');
    const target = await resolveImportTarget(
      '/tmp/elsewhere/tune.flac',
      folder,
    );
    expect(target).toBe(path.join(folder, 'tune (1).flac'));
  });

  it('handles dotted basenames correctly (only the last . is the extension)', async () => {
    await fs.writeFile(path.join(folder, 'song.live.mp3'), '');
    const target = await resolveImportTarget(
      '/tmp/elsewhere/song.live.mp3',
      folder,
    );
    expect(target).toBe(path.join(folder, 'song.live (1).mp3'));
  });
});
