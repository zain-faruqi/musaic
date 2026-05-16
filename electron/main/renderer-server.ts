import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fsPromises, createReadStream } from 'node:fs';
import { extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { resolveAppAssetPath } from './renderer-asset-path';

/**
 * Embedded localhost HTTP server that serves the renderer bundle in
 * packaged builds.
 *
 * # Why this exists
 *
 * Packaged Electron used to load the renderer via `loadFile(...)`,
 * giving the renderer document a `file://` origin. YouTube's IFrame
 * Player API rejects embeds from `file://` origins (error 101/150,
 * "embed-disallowed"). An earlier attempt used a custom
 * `musaic-app://` privileged protocol; that fixed the
 * `file://` case but YouTube still rejected the custom scheme (with
 * error 153, "video player configuration error" — different code,
 * same root cause: YT's embed-permission check accepts neither
 * `file://` nor a non-http(s) custom scheme). The brief's residual-
 * risk path was this: serve the renderer over a real http origin.
 *
 * A subsequent finding refined the host string: the origin is
 * `http://localhost:<port>`, not `http://127.0.0.1:<port>`, because
 * YouTube treats `localhost` as a development context and exempts it
 * from rights-holder Content ID embed restrictions that the IP
 * literal does not get exempted from. The bind address is still
 * `127.0.0.1` (security model unchanged); only the host string used
 * in the URL handed to `loadURL` is `localhost`.
 *
 * # Why http://127.0.0.1 (not 0.0.0.0) for the bind
 *
 * The renderer bundle isn't a LAN service. Binding to 0.0.0.0 would
 * expose the renderer to every device on the user's network. 127.0.0.1
 * keeps the server reachable only from the local machine; the
 * BrowserWindow is the only intended consumer.
 *
 * # Why an OS-assigned port (`listen(0)`)
 *
 * A hardcoded port would collide with any other app that happened to
 * use it. `listen(0)` asks the OS to pick a free port; we read the
 * actual port from `server.address()` after `listen` resolves and
 * use it in the origin URL passed to `BrowserWindow.loadURL()`.
 * Different launches get different ports; that's fine because nothing
 * outside the running process knows the port.
 *
 * # Security model
 *
 * - Localhost-only binding (above).
 * - Path containment: every request goes through
 *   `resolveAppAssetPath`, which rejects anything that would resolve
 *   outside `rendererDir`. The renderer bundle is static, code-
 *   reviewable content; serving it doesn't expose secrets.
 * - GET / HEAD only; everything else returns 405. There's no API to
 *   abuse — we're a static file server, not a backend.
 * - No CORS headers / auth tokens / cookies: the only consumer is
 *   our own BrowserWindow loading its own document.
 *
 * # Lifecycle
 *
 * `startRendererServer` is called once in `app.whenReady()` before
 * the BrowserWindow opens (the window needs the origin to construct
 * `loadURL`). The returned `close()` is wired into `before-quit`
 * fire-and-forget — process exit closes the socket anyway, so
 * graceful close is best-effort polish, not required.
 *
 * # SPA routing (not implemented)
 *
 * Today the renderer is a single page driven by component state, not
 * URL routing. Unknown paths 404. If SPA routes are added later, the
 * handler should fall back to `index.html` for paths that look like
 * routes (no file extension, doesn't match an asset on disk). Flagged
 * here so it's not a surprise when that change happens.
 */
export interface RendererServer {
  /**
   * Origin URL of the running server, e.g. `http://localhost:54321`.
   * The host string is `localhost` even though the bind address is the
   * IP literal `127.0.0.1`; see the implementation comment on
   * construction for why.
   */
  readonly origin: string;
  /**
   * Stop the server. Fire-and-forget on quit is fine; process exit
   * reaps the socket. Returns a Promise that resolves when all
   * in-flight requests have drained.
   */
  close(): Promise<void>;
}

/**
 * Content-Type table by file extension. Limited to what the vite
 * build actually emits to `out/renderer/` (HTML, JS, CSS, JSON, a
 * handful of image and font types) plus a couple of common cases
 * that might land later (.ico, .webp).
 *
 * No `charset=` on binary types. UTF-8 explicit on the text ones —
 * Node's http response object doesn't add a default charset, and
 * some browsers will guess wrong on JS / CSS / JSON without one.
 *
 * Unknown extensions fall back to `application/octet-stream`. That's
 * safe (browsers won't execute it) but means we'd notice if a new
 * asset type started shipping without a matching entry here.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

/**
 * Build the request handler. Factored out so the server's lifecycle
 * code (start / address-extraction / close) stays focused on those
 * concerns and the request handling is testable on its own.
 */
const buildHandler = (rendererDir: string) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Method check. We only serve static files; mutating requests
    // have no meaning here. 405 is the correct HTTP code; include
    // the `Allow` header per RFC 7231 §6.5.5.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('method not allowed');
      return;
    }

    // `req.url` is the request-target — path + query, like
    // `/assets/foo.js?v=1`. Parse it via URL with a dummy base to
    // get the pathname cleanly without splitting strings ourselves.
    // The base is required because `req.url` is path-relative.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`renderer-server: bad url "${req.url ?? ''}": ${msg}`);
      res.statusCode = 400;
      res.end('bad request');
      return;
    }

    // Defense-in-depth path resolution. The URL parser collapses
    // `..` segments in standard schemes, but the helper also runs
    // the containment check that catches sibling-directory prefix
    // attacks and any future Node URL-parser surprises.
    const resolved = resolveAppAssetPath(rendererDir, decodeURIComponent(pathname));
    if (!resolved.ok) {
      console.error(`renderer-server: rejected path-traversal attempt: ${pathname}`);
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    // stat-check before opening a stream so a missing file produces
    // a clean 404 with a useful log line instead of a stream-error
    // mid-pipe. Bonus: we get the file size for Content-Length.
    let size: number;
    try {
      const stats = await fsPromises.stat(resolved.filePath);
      if (!stats.isFile()) {
        // e.g. a directory request — same not-found shape.
        console.error(`renderer-server: not a regular file: ${resolved.filePath}`);
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      size = stats.size;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`renderer-server: stat failed for ${resolved.filePath}: ${msg}`);
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const ext = extname(resolved.filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(size));

    if (req.method === 'HEAD') {
      // HEAD: same headers as GET, no body. Some asset-loaders or
      // health-check tools use HEAD; cheap to support.
      res.end();
      return;
    }

    // Stream the file. createReadStream is bounded buffer, no risk
    // of loading a big asset wholesale. If the consumer aborts mid-
    // pipe (renderer reloads, navigates away), `req` emits 'close'
    // and we destroy the stream to release the file handle.
    const stream = createReadStream(resolved.filePath);
    req.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.on('error', (err) => {
      console.error(`renderer-server: stream error for ${resolved.filePath}: ${err.message}`);
      // If headers are already sent, we can only destroy the
      // connection; the client will see a truncated response.
      if (res.headersSent) {
        res.destroy(err);
      } else {
        res.statusCode = 500;
        res.end('server error');
      }
    });
    stream.pipe(res);
  };

/**
 * Start the embedded localhost server. Binds to `127.0.0.1` on an
 * OS-assigned port; reads the actual port from `server.address()`
 * after `listen` resolves and returns the resulting origin URL as
 * `http://localhost:<port>` (host string `localhost`, bind address
 * `127.0.0.1` — see the construction-site comment for why).
 */
export async function startRendererServer(
  rendererDir: string,
): Promise<RendererServer> {
  const handler = buildHandler(rendererDir);
  const server: Server = createServer((req, res) => {
    // Top-level catch so a handler error never leaves the response
    // hanging. The handler itself catches its own per-request errors
    // and writes responses; this is the last-resort safety net.
    void handler(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`renderer-server: unhandled handler error: ${msg}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('server error');
      } else {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // listen(0) → OS-assigned port; explicit 127.0.0.1 host so we
    // don't accidentally bind to all interfaces on dual-stack systems.
    server.listen(0, '127.0.0.1');
  });

  const addr = server.address() as AddressInfo | string | null;
  if (typeof addr !== 'object' || addr === null) {
    // server.address() returns string only for Unix-socket / pipe
    // servers; we explicitly bound to a TCP port, so the AddressInfo
    // shape is what we expect. Defensive in case of future Node
    // behavior surprises.
    throw new Error(
      `renderer-server: expected AddressInfo, got ${typeof addr === 'string' ? `string "${addr}"` : 'null'}`,
    );
  }

  // Host string is `localhost`, not `127.0.0.1`, even though the bind
  // is the IP literal. The two are not equivalent to YouTube's embed-
  // permission system: `localhost` gets a development-context pass on
  // rights-holder Content ID embed restrictions (the per-artist
  // "embed-disallowed" 150 wall), while the IP literal does not.
  // Empirically: in packaged builds with origin `http://127.0.0.1:<port>`,
  // the IFrame Player API rejected major-label music videos with
  // code 150 even though the unrestricted long tail played fine; the
  // same videos played in dev (`http://localhost:<vite-port>`) and
  // play in packaged after this host-string change. The OS resolver
  // maps `localhost` to `127.0.0.1` so Chromium connects to the same
  // socket the server is listening on — security model and bind
  // address are unchanged.
  const origin = `http://localhost:${addr.port}`;

  return {
    origin,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}
