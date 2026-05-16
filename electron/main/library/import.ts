/**
 * The library:import pipeline.
 *
 * Single function rather than IPC-handler-shaped so it's directly
 * testable and the IPC handler stays thin (dialog + dispatch + error
 * shaping).
 *
 *   1. Validate the extension. Defense-in-depth — the dialog filter
 *      should already have constrained this, but main treats every
 *      input as untrusted.
 *   2. Scan metadata FIRST, before any fs writes. If the file is
 *      unreadable, the Musaic folder doesn't get a copy of it.
 *   3. Resolve target path (handles "already inside" + collisions).
 *   4. Copy if needed.
 *   5. Stat target for mtime.
 *   6. Upsert row, return the over-the-wire LocalTrack.
 */
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import type { LibraryTrack } from '../../ipc/channels';
import { trackRowToUnifiedTrack, type TrackRow } from '../db/schema';
import { upsertTrack } from '../db/tracks';
import { resolveImportTarget } from './musaic-folder';

// Duplicated rather than imported from src/core/file-types because
// electron/ and src/ are bundled into separate processes with separate
// tsconfigs — same convention as the PLAYABLE_EXTENSIONS set in
// electron/main/index.ts. Keep the two lists in sync.
const PLAYABLE_EXTENSIONS = new Set([
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
  'mp4', 'm4v', 'mov', 'webm',
]);

function lowerExt(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0 || lastDot === filePath.length - 1) return '';
  return filePath.slice(lastDot + 1).toLowerCase();
}

function isPlayableExtension(filePath: string): boolean {
  return PLAYABLE_EXTENSIONS.has(lowerExt(filePath));
}

type ScannedMetadata = {
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string | null;
  readonly durationMs: number;
  readonly isrc: string | null;
};

/**
 * Read tags from a file. Throws on hard parse error (caller surfaces
 * to UI). Empty/missing tags are filled with reasonable fallbacks
 * derived from the filename.
 */
export async function scanMetadata(filePath: string): Promise<ScannedMetadata> {
  let parsed: IAudioMetadata;
  try {
    parsed = await parseFile(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new Error(
      `could not read metadata for ${path.basename(filePath)}: ${reason}`,
    );
  }
  const common = parsed.common;
  const fallbackTitle = path.basename(filePath, path.extname(filePath));

  const title = common.title?.trim() || fallbackTitle;
  const artists =
    common.artists !== undefined && common.artists.length > 0
      ? common.artists.map((a) => a.trim()).filter((a) => a.length > 0)
      : [];
  const finalArtists = artists.length > 0 ? artists : ['Unknown Artist'];

  const album = common.album?.trim() || null;
  const durationSec = parsed.format.duration;
  const durationMs =
    typeof durationSec === 'number' && durationSec > 0
      ? Math.round(durationSec * 1000)
      : 0;
  const isrc = common.isrc?.[0] ?? null;

  return {
    title,
    artists: finalArtists,
    album,
    durationMs,
    isrc,
  };
}

/**
 * The full import flow, factored out of the IPC handler so it can be
 * unit-tested without an Electron dialog. Throws on:
 *   - unsupported extension
 *   - metadata parse failure
 *   - copy or stat failure (rare but real — disk full, permissions)
 */
export async function importFile(
  srcPath: string,
  musaicFolder: string,
  db: DatabaseSync,
): Promise<LibraryTrack> {
  if (!isPlayableExtension(srcPath)) {
    throw new Error(
      `unsupported file type: ${path.extname(srcPath) || '<no extension>'}`,
    );
  }

  // Scan first, before any fs writes.
  const meta = await scanMetadata(srcPath);

  const targetPath = await resolveImportTarget(srcPath, musaicFolder);

  if (targetPath !== srcPath) {
    await fs.copyFile(srcPath, targetPath);
  }

  const stat = await fs.stat(targetPath);
  const now = Date.now();

  // `source_id` for local rows is the absolute path. `path` stores the
  // same value so the watcher's deleteByPath query can find it without
  // having to know the (source, source_id) tuple. `artwork_url` stays
  // null until embedded cover-art extraction lands (v2).
  const row: TrackRow = {
    source: 'local',
    source_id: targetPath,
    path: targetPath,
    title: meta.title,
    artists: JSON.stringify(meta.artists),
    album: meta.album,
    duration_ms: meta.durationMs,
    isrc: meta.isrc,
    artwork_url: null,
    mtime: stat.mtimeMs,
    // On conflict, upsertTrack preserves the existing created_at, so
    // re-importing doesn't bump a track's "Recently Added" position.
    created_at: now,
  };
  upsertTrack(db, row);

  return trackRowToUnifiedTrack(row);
}
