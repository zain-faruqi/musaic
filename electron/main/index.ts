import { app, BrowserWindow, protocol, components, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promises as fsPromises, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { CHANNELS } from '../ipc/channels';
import { startRendererServer, type RendererServer } from './renderer-server';
import { registerLibraryHandlers } from './ipc/library';
import { registerYouTubeHandlers } from './ipc/youtube';
import { registerSystemHandlers } from './ipc/system';
import { registerSpotifyHandlers } from './ipc/spotify';
import {
  makeBroadcastPlaylistChanged,
  registerPlaylistHandlers,
} from './ipc/playlists';
import { parseRange } from './range';
import { openDb } from './db';
import {
  ensureMusaicFolder,
  getMusaicFolderPath,
} from './library/musaic-folder';
import { startLibraryWatcher } from './library/watcher';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep in sync with src/core/constants.ts. Duplicated rather than
// imported because electron/ and src/ are bundled into separate
// processes with separate tsconfigs.
const LOCAL_FILE_PROTOCOL = 'musaic-file';

const PLAYABLE_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus',
  '.mp4', '.m4v', '.mov', '.webm',
]);

// Explicit Content-Type per extension. Without this, Chromium's audio
// decoder has to sniff, and some files (notably .m4a / .aac with
// imperfect container metadata) get rejected as unrecognized.
const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const lowerExt = (path: string): string => {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
};

// Privileged scheme registration must happen before app.whenReady().
// Without `standard: true` the URL parser strips the path; without
// `stream: true` body responses can't pipe through; the rest are
// minor capability flags.
protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_FILE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
    },
  },
]);

const createWindow = (rendererUrl: string): void => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    webPreferences: {
      // Preload bundle is CJS — see electron.vite.config.ts comment.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Allow media playback to start without a user gesture. We need
      // this for cross-source handoff: when PlayerManager finishes a
      // local track and promotes a preloaded YouTube adapter, the
      // resulting `playVideo()` call happens from a setInterval
      // timeupdate → ended → promoteNext chain, with no user
      // activation in scope. Chromium's default policy
      // (`document-user-activation-required`) lets the cross-origin
      // YouTube iframe silently refuse the play and surface its
      // own "click to play" overlay instead.
      //
      // Justification: this is a media player. The user has
      // explicitly added the track to the queue; autoplay on
      // handoff is the whole point of having a queue. The same
      // setting will be needed for Spotify's Web Playback SDK in
      // M2 (its internal <audio> element is in our renderer but
      // would still be subject to the same policy on resume).
      //
      // Security boundary unchanged: contextIsolation / nodeIntegration
      // / sandbox above are the actual sandbox; autoplay policy is
      // orthogonal.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Intercept window.open() and target=_blank navigations. Electron's
  // default is to spawn a new BrowserWindow loading the URL inline,
  // which is why clicking "Watch video on YouTube" inside the YouTube
  // iframe's error UI was opening the page inside Musaic rather than
  // the user's default browser. Forward HTTPS URLs to the OS via
  // shell.openExternal; deny everything else, including the new
  // BrowserWindow electron would otherwise create.
  //
  // Allowlist is intentionally narrow: we only let URLs through that
  // a legitimate flow in this app would produce. The renderer's own
  // affordances use the `system:open-external` IPC channel which has
  // its own allowlist (see electron/main/ipc/system.ts) — this handler
  // is the second line of defense, for navigation requests that
  // originate inside webContents (an iframe's link, a popup, etc.).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const allowed =
      url.startsWith('https://www.youtube.com/') ||
      url.startsWith('https://youtube.com/') ||
      url.startsWith('https://youtu.be/') ||
      url.startsWith('https://www.youtube-nocookie.com/');
    if (allowed) {
      void shell.openExternal(url);
    } else {
      console.warn('window-open handler blocked URL:', url);
    }
    return { action: 'deny' };
  });

  // Dev: `rendererUrl` is the vite dev server (HMR). Packaged: it's
  // the embedded localhost HTTP server's index.html URL. The decision
  // about which to use is made in `app.whenReady()`; this function
  // just loads whatever it's given.
  void mainWindow.loadURL(rendererUrl);
};

/**
 * Serve a local media file in response to a `musaic-file://` request.
 *
 * Honors HTTP Range requests via `fs.createReadStream({ start, end })`.
 * This is what makes scrubber seeking work — when the renderer sets
 * `<audio>.currentTime = 28`, Chromium issues `Range: bytes=N-` for the
 * byte offset corresponding to that timestamp, and we must respond with
 * a 206 Partial Content holding only those bytes. Without Range support
 * the audio decoder snaps back to the start of the file (byte 0)
 * because that's what we keep handing it.
 */
const handleLocalFile = async (request: Request): Promise<Response> => {
  let filePath: string;
  try {
    const url = new URL(request.url);
    if (url.protocol !== LOCAL_FILE_PROTOCOL + ':') {
      return new Response('bad protocol', { status: 400 });
    }
    filePath = decodeURIComponent(url.pathname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('local-file-protocol: bad url:', msg);
    return new Response('bad request', { status: 400 });
  }

  // TODO(security, M1→M2): once the SQLite library index lands,
  // restrict serving to paths in the index. Today the renderer can
  // construct any musaic-file:// URL; the extension gate below limits
  // this to media files but isn't a full guarantee.
  const ext = lowerExt(filePath);
  if (!PLAYABLE_EXTENSIONS.has(ext)) {
    return new Response('not a playable media file', { status: 403 });
  }

  let totalSize: number;
  try {
    const stats = await fsPromises.stat(filePath);
    totalSize = stats.size;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error(`local-file-protocol: stat failed for ${filePath}: ${msg}`);
    return new Response('not found', { status: 404 });
  }

  const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const rangeResult = parseRange(request.headers.get('range'), totalSize);

  if (rangeResult.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  if (rangeResult.kind === 'ok') {
    const { start, end } = rangeResult;
    const nodeStream = createReadStream(filePath, { start, end });
    // Readable.toWeb propagates cancellation: if the consumer aborts,
    // the underlying file handle gets destroyed.
    const body = Readable.toWeb(nodeStream) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // No Range, or Range malformed — serve the whole file. Per RFC 7233
  // §3.1, malformed Range headers are ignored (treated as absent).
  const nodeStream = createReadStream(filePath);
  const body = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
    },
  });
};

void app.whenReady().then(async () => {
  // Castlabs: wait for the Widevine CDM Component Updater Service to
  // finish installing/updating Widevine before opening any window.
  // First launch: downloads + installs CDM. Subsequent launches: fast
  // background update check, usually a few ms. Skipping this await
  // races the BrowserWindow against CDM availability — the Spotify
  // Web Playback SDK iframe loads before Widevine is registered and
  // license requests come back 500 from
  // api.spotify.com/v1/widevine-license/v1/audio/license, which looks
  // identical to "castlabs's signature is rejected" but is actually
  // "we didn't wait." Guard so stock Electron doesn't crash if anyone
  // briefly swaps `electron` back to upstream for an unrelated debug.
  if (typeof components !== 'undefined' && components !== null) {
    try {
      await components.whenReady();
      // status() returns null on stock electron; on castlabs it's a
      // per-component status object keyed by component id. Logged
      // once on boot for diagnosis.
      console.log('castlabs components ready:', components.status());
    } catch (err) {
      // A castlabs ComponentsError carries an `errors: ComponentError[]`
      // field with the per-component diagnostic (which component, what
      // failed, what the underlying network/state error was). The top-
      // level err.message is just "Failed to install required components"
      // and tells us nothing actionable; the per-component errors are
      // what we need. Log both, plus components.status() so we can see
      // what state the updater left things in (issue #118: 'new' means
      // downloaded-but-not-registered-this-session; a relaunch often
      // resolves it).
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('castlabs components.whenReady failed:', msg);
      const errors = (err as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        console.error('castlabs ComponentError[]:');
        for (const e of errors) {
          // ComponentError shape per castlabs docs:
          //   { id: string, name: string, error: string }
          // Use JSON for full fidelity in case the shape varies.
          try {
            console.error('  -', JSON.stringify(e));
          } catch {
            console.error('  -', String(e));
          }
        }
      } else {
        console.error('  (no per-component errors array on rejection)');
      }
      try {
        console.error('castlabs components.status() after failure:', components.status());
      } catch (statusErr) {
        const sm = statusErr instanceof Error ? statusErr.message : 'unknown';
        console.error('castlabs components.status() also threw:', sm);
      }
      console.error(
        'Hint: castlabs issue #118 — first-launch installs can succeed on disk but fail to register for the current session. Quit the app fully (Cmd+Q) and re-run `npm run dev`. If a relaunch does not help, the castlabs pin may need bumping to a more recent maintained major.',
      );
    }
  }

  protocol.handle(LOCAL_FILE_PROTOCOL, handleLocalFile);

  // ~/Library/Application Support/Musaic/musaic.db on macOS.
  const musaicFolder = getMusaicFolderPath();
  await ensureMusaicFolder(musaicFolder);

  const db = openDb({
    path: join(app.getPath('userData'), 'musaic.db'),
  });

  registerLibraryHandlers(db);

  // Broadcaster for library:changed. Defined here (rather than inside
  // startLibraryWatcher) so the youtube:save handler can also fire it
  // — both the watcher and a YouTube paste-and-save are valid reasons
  // for the renderer to re-fetch the library.
  //
  // Signal-only: the renderer treats this as a re-fetch trigger and
  // pulls a fresh list via library:list. Delta payloads are a future
  // optimization.
  const broadcastLibraryChanged = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      // Guard against destroyed webContents (window mid-close).
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.libraryChanged);
      }
    }
  };

  registerYouTubeHandlers(db, broadcastLibraryChanged);

  // Reconcile (one-shot) and then start chokidar. Each add/unlink the
  // watcher processes turns into a `library:changed` broadcast.
  //
  // Reconciliation does NOT fire the broadcast — the renderer's
  // initial mount calls library:list anyway, and an extra signal at
  // boot would just cause a double-fetch.
  await startLibraryWatcher(musaicFolder, db, broadcastLibraryChanged);

  registerSystemHandlers();

  // Spotify auth + save surface. Registers the
  // four request/response auth handlers (connect / disconnect / status
  // / get-token), the `spotify:save` paste-and-save handler, and
  // wires the status-changed push channel.
  registerSpotifyHandlers(db, broadcastLibraryChanged);

  // Local playlist surface. Eight CRUD channels plus the
  // playlist:changed push. Mirrors library / spotify in shape:
  // broadcaster built once, threaded into the registration so the
  // BrowserWindow walk lives in one helper.
  registerPlaylistHandlers(db, makeBroadcastPlaylistChanged());

  // Decide the renderer URL once. Dev: vite serves it with HMR;
  // packaged: an embedded localhost HTTP server we own. The server
  // is the canonical fix for YouTube's IFrame Player API refusing
  // to embed under `file://` or any non-http(s) custom scheme.
  let rendererServer: RendererServer | null = null;
  let rendererUrl: string;
  if (process.env['ELECTRON_RENDERER_URL']) {
    rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  } else {
    // __dirname in main bundle: out/main/. Renderer bundle: out/renderer/.
    const rendererDir = join(__dirname, '../renderer');
    rendererServer = await startRendererServer(rendererDir);
    rendererUrl = `${rendererServer.origin}/index.html`;
    console.log(`renderer-server: listening at ${rendererServer.origin}`);
  }

  createWindow(rendererUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(rendererUrl);
  });

  // Lifecycle: close the renderer server on quit. Fire-and-forget
  // because before-quit is sync and awaiting here would block the
  // shutdown. Process exit reaps the socket regardless; this is
  // best-effort graceful close, not a correctness requirement.
  app.on('before-quit', () => {
    if (rendererServer !== null) {
      void rendererServer.close().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error('renderer-server: close failed:', msg);
      });
    }
  });
});

app.on('window-all-closed', () => {
  // macOS-only build, but keep standard quit
  // semantics for non-macOS dev runs.
  if (process.platform !== 'darwin') app.quit();
});
