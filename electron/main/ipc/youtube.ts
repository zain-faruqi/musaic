/**
 * YouTube IPC handler.
 *
 * `youtube:save` — paste-and-save. Renderer hands main a URL string;
 *   main parses, fetches oEmbed, upserts the row, broadcasts
 *   library:changed, returns a discriminated result. The save pipeline
 *   itself lives in ../youtube/save.ts so it's testable independent of
 *   the IPC plumbing.
 *
 * On success / embed-restricted, library:changed fires so the renderer
 * re-fetches via library:list. The new row appears in the home view's
 * Recently Added section.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ipcMain } from 'electron';
import {
  CHANNELS,
  youtubeSaveInput,
  youtubeSaveOutput,
  type YouTubeSaveOutput,
} from '../../ipc/contracts';
import { saveYouTubeUrl } from '../youtube/save';

export function registerYouTubeHandlers(
  db: DatabaseSync,
  broadcastLibraryChanged: () => void,
): void {
  ipcMain.handle(
    CHANNELS.youtubeSave,
    async (_event, payload: unknown): Promise<YouTubeSaveOutput> => {
      // Treat renderer payloads as untrusted — validate at the boundary
      //.
      const { url } = youtubeSaveInput.parse(payload);
      const result = await saveYouTubeUrl(url, db);
      // Broadcast only when the save actually persisted a row.
      // `not-found` doesn't change the library; broadcasting would
      // trigger a wasted refetch.
      if (result.kind !== 'not-found') {
        broadcastLibraryChanged();
      }
      // Self-validate outbound to catch drift between save.ts and the
      // contract — same rationale as library:import's outbound parse.
      return youtubeSaveOutput.parse(result);
    },
  );
}
