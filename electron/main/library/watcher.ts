/**
 * Local-library watcher.
 *
 * Two pieces, run in order at app boot:
 *
 *   1. `reconcile(folder, db)` — list playable files in the Musaic
 *      folder, diff against the SQLite index, scan-and-upsert any
 *      that are on disk but not indexed. Chokidar's `ignoreInitial:
 *      false` mode would fire `add` for every existing file at boot
 *      and we'd re-scan the entire library every launch; doing the
 *      diff first means we only pay for what actually changed.
 *
 *   2. `startWatcher(folder, db, onChanged)` — start chokidar with
 *      `ignoreInitial: true`. On `add`, run the full import pipeline
 *      (path-dedup is in importFile's upsert). On `unlink`, drop the
 *      row.
 *
 * Both share `importFile` from ./import — its `scanMetadata` step is
 * the reusable seam. The watcher does not re-implement metadata
 * scanning.
 *
 * Known edge case: moving a file inside the Musaic folder fires
 * `unlink` then `add` separately, losing the row's `created_at`.
 * Detecting moves cheaply needs inode tracking which chokidar doesn't
 * surface uniformly across platforms.
 * TODO(rename-detection, v2): if this becomes a real complaint, add
 * a short-window inode-matching layer between the unlink and add.
 */
import type { DatabaseSync } from 'node:sqlite';
import { watch, type FSWatcher } from 'chokidar';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deleteByPath } from '../db/tracks';
import { importFile } from './import';

// Duplicated rather than imported from src/core/file-types — see the
// comment in ./import.ts. Same set, same sync responsibility.
const PLAYABLE_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus',
  '.mp4', '.m4v', '.mov', '.webm',
]);

const isPlayablePath = (p: string): boolean =>
  PLAYABLE_EXTENSIONS.has(path.extname(p).toLowerCase());

/**
 * Walk `folder` recursively, returning absolute paths of every
 * playable file. Hidden files and any path component starting with
 * `.` (e.g. `.DS_Store`, `.musaic`) are skipped — these are never
 * library content and would just cost work.
 */
async function listPlayableFiles(folder: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Folder may have been deleted mid-walk; reconciliation is
      // best-effort. Log and continue with what we have.
      const reason = err instanceof Error ? err.message : 'unknown';
      console.warn(`watcher: readdir failed for ${dir}: ${reason}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && isPlayablePath(entry.name)) {
        out.push(full);
      }
    }
  }

  await walk(folder);
  return out;
}

/**
 * Read every indexed local path from the DB into a Set for O(1)
 * membership checks during the diff. Filtered to `source='local'`
 * because reconciliation only handles local files — the
 * (source, source_id) PK means a youtube row's `source_id` (a videoId)
 * could coincidentally collide with a local path string, and we don't
 * want to treat that as "already indexed."
 *
 * Kept narrow: we only need `path`, not the full row.
 */
function indexedPaths(db: DatabaseSync): Set<string> {
  // Cast through `unknown` because `node:sqlite`'s row type is
  // `Record<string, SQLOutputValue>`, which TS won't narrow to a
  // specific shape directly (`SQLOutputValue` is the union of all
  // possible SQLite column types). The SELECT pins the column set to
  // just `path`, so the cast is a known-safe assertion — but TS's
  // strictness requires us to be explicit about it.
  const rows = db
    .prepare("SELECT path FROM tracks WHERE source = 'local' AND path IS NOT NULL")
    .all() as unknown as ReadonlyArray<{ readonly path: string }>;
  return new Set(rows.map((r) => r.path));
}

export type ReconcileResult = {
  /** Number of files that were on disk but not yet in the DB. */
  readonly imported: number;
  /** Files we tried to import but couldn't (e.g. unreadable tags). */
  readonly failed: number;
};

/**
 * Bring the SQLite index into sync with the Musaic folder, one-shot.
 * Currently only handles "on disk but missing from index"; not the
 * inverse ("indexed but file is gone") — the watcher's `unlink`
 * handler covers ongoing deletions, and a startup-time stale-row
 * cleanup is a v2 concern (no UI yet to surface broken tracks).
 *
 * Pure with respect to the (folder, db) inputs; exported separately
 * from startWatcher so it's testable without chokidar in the loop.
 */
export async function reconcile(
  folder: string,
  db: DatabaseSync,
): Promise<ReconcileResult> {
  const onDisk = await listPlayableFiles(folder);
  const indexed = indexedPaths(db);

  let imported = 0;
  let failed = 0;
  for (const filePath of onDisk) {
    if (indexed.has(filePath)) continue;
    try {
      await importFile(filePath, folder, db);
      imported += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      console.warn(`watcher: reconcile import failed for ${filePath}: ${reason}`);
      failed += 1;
    }
  }
  return { imported, failed };
}

export type WatcherHandle = {
  /** Detach all handlers and close the underlying FSWatcher. */
  stop(): Promise<void>;
};

/**
 * Begin watching `folder` for incremental changes. Reconciliation
 * must have already run — see startLibraryWatcher for the composed
 * boot sequence.
 *
 * `onChanged` fires once per successful add or unlink. The renderer
 * uses it as a refetch signal; main never sends a payload.
 */
export function startWatcher(
  folder: string,
  db: DatabaseSync,
  onChanged: () => void,
): WatcherHandle {
  const watcher: FSWatcher = watch(folder, {
    ignoreInitial: true,
    persistent: true,
    // Chokidar 4 follows symlinks by default; for a personal music
    // folder that's the right call (a symlink to an external drive
    // is plausibly how the user organizes things).
    followSymlinks: true,
    // Brief settle window so a half-written copy doesn't fire `add`
    // before music-metadata can read the header. 100ms is enough for
    // a Finder drag-drop; longer values noticeably delay the home
    // view update.
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('add', (filePath: string) => {
    if (!isPlayablePath(filePath)) return;
    importFile(filePath, folder, db)
      .then(() => {
        onChanged();
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : 'unknown';
        console.warn(`watcher: add import failed for ${filePath}: ${reason}`);
      });
  });

  watcher.on('unlink', (filePath: string) => {
    if (!isPlayablePath(filePath)) return;
    try {
      // Local-only delete: even if some other source's row happened to
      // share the path string as its source_id, we don't want a
      // filesystem event to remove it. See deleteByPath.
      deleteByPath(db, filePath);
      onChanged();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      console.warn(`watcher: unlink delete failed for ${filePath}: ${reason}`);
    }
  });

  watcher.on('error', (err: unknown) => {
    const reason = err instanceof Error ? err.message : 'unknown';
    console.error(`watcher: chokidar error: ${reason}`);
  });

  return {
    stop: async (): Promise<void> => {
      await watcher.close();
    },
  };
}

/**
 * Composed boot sequence: reconcile first, then start the watcher.
 * Order matters — chokidar with `ignoreInitial: true` will miss any
 * change that happens before it attaches, so a file added between
 * "list folder" and "watcher ready" would be lost. Reconciliation
 * runs to completion before the watcher starts; the watcher then
 * picks up everything from that point.
 *
 * The initial reconciliation does not call `onChanged` — the renderer
 * fetches the library on first mount anyway, so an extra signal at
 * boot would just cause a double-fetch.
 */
export async function startLibraryWatcher(
  folder: string,
  db: DatabaseSync,
  onChanged: () => void,
): Promise<WatcherHandle> {
  await reconcile(folder, db);
  return startWatcher(folder, db, onChanged);
}
