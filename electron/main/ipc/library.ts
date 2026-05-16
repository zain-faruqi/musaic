/**
 * Library IPC handlers.
 *
 * `library:import` — file-picker import. Shows the open-file dialog,
 *   imports the chosen file via the importFile pipeline, returns the
 *   resulting LibraryTrack (or null on cancel). Replaces the older
 *   two-step `library:pick-file` + `library:read-track` flow — those
 *   allowed playing without indexing, which contradicts the file-source
 *   decision (Musaic folder is the canonical home).
 *
 * `library:list` — read-only: every indexed track (any source), sorted
 *   newest-first by `created_at`. Sort lives in `getAllTracks`;
 *   the contract pins the sort and the renderer doesn't re-sort.
 */
import type { DatabaseSync } from 'node:sqlite';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  CHANNELS,
  libraryImportOutput,
  libraryListOutput,
  type LibraryImportOutput,
  type LibraryListOutput,
} from '../../ipc/contracts';
import { trackRowToUnifiedTrack } from '../db/schema';
import { getAllTracks } from '../db/tracks';
import { importFile } from '../library/import';
import {
  ensureMusaicFolder,
  getMusaicFolderPath,
} from '../library/musaic-folder';

// Duplicated rather than imported from src/core/file-types — main and
// renderer are bundled by separate tsconfigs and main can't cross.
// Keep in sync with src/core/file-types and the inline lists in
// electron/main/index.ts and electron/main/library/import.ts.
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'];
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm'];

export function registerLibraryHandlers(db: DatabaseSync): void {
  ipcMain.handle(
    CHANNELS.libraryImport,
    async (): Promise<LibraryImportOutput> => {
      const folder = getMusaicFolderPath();
      await ensureMusaicFolder(folder);

      // Sheet-attached dialog when there's a focused window.
      const focused = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(focused as BrowserWindow, {
        properties: ['openFile'],
        filters: [
          { name: 'Audio', extensions: AUDIO_EXTENSIONS },
          { name: 'Video', extensions: VIDEO_EXTENSIONS },
        ],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const srcPath = result.filePaths[0];
      if (srcPath === undefined) return null;

      const track = await importFile(srcPath, folder, db);

      // Validate our own outbound shape against the contract — defends
      // against accidental drift if importFile's return shape evolves.
      return libraryImportOutput.parse(track);
    },
  );

  ipcMain.handle(
    CHANNELS.libraryList,
    (): LibraryListOutput => {
      const tracks = getAllTracks(db).map(trackRowToUnifiedTrack);
      // Same self-validation rationale as library:import: catch drift
      // before it crosses the process boundary.
      return libraryListOutput.parse(tracks);
    },
  );
}
