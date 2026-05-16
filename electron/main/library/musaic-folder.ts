/**
 * The Musaic folder is the single canonical location for the local
 * portion of the user's library.
 *
 *   ~/Music/Musaic/          (default; resolved via app.getPath('music'))
 *
 * Two ways files arrive in it:
 *   - File picker → copy from anywhere on disk into this folder
 *   - Direct drop in Finder → chokidar watcher picks it up (next milestone)
 *
 * `getMusaicFolderPath()` is the only function in here that touches
 * Electron. Everything else is pure / fs-only and unit-testable.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The absolute path to the Musaic folder. `app.getPath('music')` resolves
 * to ~/Music on macOS; we namespace under it.
 *
 * Not memoized: app.getPath() is a synchronous Electron call and cheap.
 * Memoization would just complicate testing.
 */
export function getMusaicFolderPath(): string {
  return path.join(app.getPath('music'), 'Musaic');
}

/** mkdir -p the folder. Safe to call repeatedly. */
export async function ensureMusaicFolder(folderPath: string): Promise<void> {
  await fs.mkdir(folderPath, { recursive: true });
}

/**
 * True if `filePath` is the same as `folderPath` or strictly inside it.
 *
 * Uses `path.relative` rather than string comparison so it correctly
 * rejects sibling paths whose name shares a prefix with the folder
 * (e.g. `/Music/Musaic2/x.mp3` is *not* inside `/Music/Musaic`).
 */
export function isInsideMusaicFolder(
  filePath: string,
  folderPath: string,
): boolean {
  const rel = path.relative(folderPath, filePath);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Where to put `srcPath` if we import it. Three cases:
 *
 *   1. srcPath is already inside the Musaic folder → return srcPath
 *      unchanged (caller will skip the copy).
 *   2. The basename is free in the folder → return folder/basename.
 *   3. Collision → loop with the Finder convention `name (1).ext`,
 *      `name (2).ext`, ... until a free name is found.
 *
 * Pure-ish: only stats the filesystem. Doesn't write anything.
 */
export async function resolveImportTarget(
  srcPath: string,
  folderPath: string,
): Promise<string> {
  if (isInsideMusaicFolder(srcPath, folderPath)) {
    return srcPath;
  }
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext);
  let candidate = path.join(folderPath, base + ext);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = path.join(folderPath, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}
