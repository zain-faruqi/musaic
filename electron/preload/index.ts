import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  type LibraryImportOutput,
  type LibraryListOutput,
  type MusaicBridge,
  type PlaylistAddTracksInput,
  type PlaylistAddTracksOutput,
  type PlaylistCreateInput,
  type PlaylistCreateOutput,
  type PlaylistDeleteInput,
  type PlaylistDeleteOutput,
  type PlaylistGetInput,
  type PlaylistGetOutput,
  type PlaylistListOutput,
  type PlaylistRemoveTracksInput,
  type PlaylistRemoveTracksOutput,
  type PlaylistRenameInput,
  type PlaylistRenameOutput,
  type PlaylistReorderInput,
  type PlaylistReorderOutput,
  type SpotifySaveInput,
  type SpotifySaveOutput,
  type SpotifyStatus,
  type SpotifyTokenResult,
  type SystemOpenExternalInput,
  type YouTubeSaveInput,
  type YouTubeSaveOutput,
} from '../ipc/channels';

/**
 * The bridge surface exposed to the renderer as `window.musaic`.
 *
 * Imports come from channels.ts (not contracts.ts) because contracts.ts
 * imports zod, and the sandboxed preload context can't load arbitrary
 * node_modules at runtime. channels.ts is import-free.
 *
 * Push channels (`library:changed`, `spotify:status-changed`) wrap
 * ipcRenderer.on with a function that swallows Electron's IpcRendererEvent
 * argument — the renderer-facing callback is signal-only, no args. The
 * wrapper reference (not the user's `cb`) is what gets passed to
 * `removeListener` so unsubscribe actually unhooks the listener.
 */
const bridge: MusaicBridge = {
  library: {
    importFile: (): Promise<LibraryImportOutput> =>
      ipcRenderer.invoke(CHANNELS.libraryImport),
    list: (): Promise<LibraryListOutput> =>
      ipcRenderer.invoke(CHANNELS.libraryList),
    onChanged: (cb: () => void): (() => void) => {
      // The wrapper ignores the IpcRendererEvent that ipcRenderer.on
      // passes through; library:changed is signal-only. Naming the
      // handler (rather than passing `cb` directly to `on` and `off`)
      // matters because we need a stable function reference for
      // removeListener — and because we discard the event argument,
      // `cb` itself isn't the right reference to register.
      const handler = (): void => {
        cb();
      };
      ipcRenderer.on(CHANNELS.libraryChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(CHANNELS.libraryChanged, handler);
      };
    },
  },
  youtube: {
    save: (input: YouTubeSaveInput): Promise<YouTubeSaveOutput> =>
      ipcRenderer.invoke(CHANNELS.youtubeSave, input),
  },
  system: {
    openExternal: (input: SystemOpenExternalInput): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.systemOpenExternal, input),
  },
  spotify: {
    connect: (): Promise<SpotifyStatus> =>
      ipcRenderer.invoke(CHANNELS.spotifyConnect),
    disconnect: (): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.spotifyDisconnect),
    status: (): Promise<SpotifyStatus> =>
      ipcRenderer.invoke(CHANNELS.spotifyStatus),
    getToken: (): Promise<SpotifyTokenResult> =>
      ipcRenderer.invoke(CHANNELS.spotifyGetToken),
    onStatusChanged: (cb: () => void): (() => void) => {
      // Same wrapper pattern as library.onChanged above; see the
      // comment there for why we name the handler.
      const handler = (): void => {
        cb();
      };
      ipcRenderer.on(CHANNELS.spotifyStatusChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(CHANNELS.spotifyStatusChanged, handler);
      };
    },
    save: (input: SpotifySaveInput): Promise<SpotifySaveOutput> =>
      ipcRenderer.invoke(CHANNELS.spotifySave, input),
  },
  playlist: {
    create: (input: PlaylistCreateInput): Promise<PlaylistCreateOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistCreate, input),
    rename: (input: PlaylistRenameInput): Promise<PlaylistRenameOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistRename, input),
    delete: (input: PlaylistDeleteInput): Promise<PlaylistDeleteOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistDelete, input),
    list: (): Promise<PlaylistListOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistList),
    get: (input: PlaylistGetInput): Promise<PlaylistGetOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistGet, input),
    addTracks: (
      input: PlaylistAddTracksInput,
    ): Promise<PlaylistAddTracksOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistAddTracks, input),
    removeTracks: (
      input: PlaylistRemoveTracksInput,
    ): Promise<PlaylistRemoveTracksOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistRemoveTracks, input),
    reorder: (input: PlaylistReorderInput): Promise<PlaylistReorderOutput> =>
      ipcRenderer.invoke(CHANNELS.playlistReorder, input),
    onChanged: (cb: () => void): (() => void) => {
      // Same wrapper pattern as library.onChanged / spotify.onStatusChanged;
      // see the comment on library.onChanged. The handler reference (not
      // the user's cb) is what gets passed to removeListener.
      const handler = (): void => {
        cb();
      };
      ipcRenderer.on(CHANNELS.playlistChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(CHANNELS.playlistChanged, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('musaic', bridge);
