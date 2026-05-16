/**
 * One-shot OAuth callback server for Spotify's authorization-code flow.
 *
 * Loopback HTTP server for the OAuth redirect step. Spotify's
 * Nov-2025 OAuth migration requires `127.0.0.1` redirects (no
 * `localhost`); the server below complies. Substantive details:
 *
 *   - Production naming: `startCallbackServer` returns a discriminated
 *     `{ code } | { error }` result; the orchestrator decides what to
 *     do with each.
 *   - State mismatch *rejects* rather than resolving with a sentinel.
 *     A state mismatch means either a CSRF attempt or a flow that
 *     overlapped with another — both are programmer-visible errors,
 *     not user-visible auth outcomes.
 *   - Timeout is parameterized so tests can drive it with a short
 *     window.
 *   - `code` query param missing is also a reject, not a silent error
 *     state — Spotify's contract is "either `code` or `error`, never
 *     both, never neither," so seeing neither is also a programmer-
 *     visible bug.
 *
 * Spotify's Nov 2025 OAuth migration deprecated `localhost` redirects;
 * the dashboard now only accepts `127.0.0.1` literals for HTTP redirect
 * URIs (per docs/spotify-setup.md). Both the URL we
 * hand to the authorize endpoint AND the URI registered in the dashboard
 * must be `http://127.0.0.1:8765/callback` exactly. Port and host below
 * are not configuration — they are the registered redirect URI.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export const LOOPBACK_HOST = '127.0.0.1';
export const LOOPBACK_PORT = 8765;
export const REDIRECT_URI = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/callback`;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

/**
 * Result of awaiting the redirect.
 *
 *   - `{ code }` — happy path: Spotify redirected with the auth code,
 *     state matched.
 *   - `{ error }` — Spotify returned an `error` param (user denied
 *     consent, invalid_scope, etc.). Caller decides the UX.
 *
 * Rejections (NOT in this union):
 *   - "state mismatch" — programmer error or CSRF; not a user outcome.
 *   - "oauth timeout" — caller's responsibility to wait or retry.
 *   - "port in use" — operational, caller surfaces.
 *   - "no code, no error" — Spotify contract violation; surface loudly.
 */
export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description?: string };

export type StartCallbackServerOptions = {
  /** Expected `state` query value. Mismatch → reject. */
  readonly state: string;
  /** Max wait before reject. Defaults to DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
};

/**
 * Bind a one-shot HTTP server on `127.0.0.1:8765`, await the first
 * `/callback` request, return what we got.
 *
 * Lifecycle:
 *   1. listen on 127.0.0.1:8765
 *   2. First request to /callback resolves or rejects the promise
 *      AND closes the server
 *   3. Timeout fires → rejects + closes
 *   4. Listen-time error (EADDRINUSE etc.) → rejects, server may
 *      never have opened
 *
 * The server is always closed by the time this function settles —
 * happy path, reject path, or timeout. No leaked listeners.
 */
export function startCallbackServer(
  opts: StartCallbackServerOptions,
): Promise<CallbackResult> {
  const expectedState = opts.state;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CallbackResult>((resolve, reject) => {
    let server: Server;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    // Single settle-and-close path. Without this, the timeout firing
    // after a real response (and vice versa) double-settles, and the
    // server gets closed twice. `settled` is the boolean we'd use
    // anyway; pulling the close+resolve/reject into one function makes
    // it impossible to forget.
    //
    // `closeAllConnections()` (Node 18.2+) is required for prompt port
    // release: `server.close()` alone only stops accepting new
    // connections, leaving any keepalive sockets from the just-served
    // response holding the port. Without the force-drop, the next
    // connect attempt would hit EADDRINUSE for the brief window before
    // the OS reclaims the socket. The HTTP response has already been
    // sent at this point, so closing the underlying TCP connection is
    // safe — the browser tab has its bytes.
    const settle = (
      action: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (server !== undefined) {
        // Drop existing connections first, then close the listener.
        // Order matters: closeAllConnections after close() is a no-op
        // because close() already stopped iterating live sockets.
        server.closeAllConnections();
        server.close((closeErr) => {
          if (closeErr !== undefined) {
            // close() error after we've already settled — log only.
            console.error('spotify oauth: server close error:', closeErr.message);
          }
        });
      }
      action();
    };

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      // We tolerate weird paths during scan-the-loopback noise; only
      // /callback is the real flow. Anything else gets a generic 404
      // and does NOT settle the promise.
      const url = new URL(
        req.url ?? '/',
        `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`,
      );
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not the callback');
        return;
      }

      const code = url.searchParams.get('code');
      const errorParam = url.searchParams.get('error');
      const errorDesc = url.searchParams.get('error_description');
      const state = url.searchParams.get('state');

      // State mismatch comes first — even if `error` or `code` are
      // present, an unsigned state value can't be trusted as theirs.
      // Defensive against cross-flow injection: if a previous flow's
      // redirect lands here after the user re-initiates, we don't
      // want to consume its code as if it belonged to the current
      // attempt.
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('state mismatch');
        settle(() => {
          reject(new Error('spotify oauth: state mismatch'));
        });
        return;
      }

      if (errorParam !== null) {
        // User denied, invalid_scope, etc. Not a programmer error;
        // surface to the caller as a CallbackResult.
        respondClosable(
          res,
          200,
          'Auth failed',
          errorDesc !== null ? `${errorParam}: ${errorDesc}` : errorParam,
        );
        settle(() => {
          const result: CallbackResult = {
            kind: 'error',
            error: errorParam,
            ...(errorDesc !== null && { description: errorDesc }),
          };
          resolve(result);
        });
        return;
      }

      if (code === null) {
        // Spotify's contract says either `code` or `error` must be
        // present. Seeing neither is a contract violation — reject
        // loudly so the caller can surface "Spotify returned an
        // empty redirect" rather than silently appearing to work.
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('missing code');
        settle(() => {
          reject(new Error('spotify oauth: redirect missing both code and error'));
        });
        return;
      }

      // Happy path. The browser tab stays open showing this message;
      // focus returns to Electron via the connect() promise chain.
      respondClosable(
        res,
        200,
        'Connected.',
        'You can close this window and return to Musaic.',
      );
      settle(() => {
        resolve({ kind: 'code', code });
      });
    };

    server = createServer(handler);

    server.on('error', (err: Error & { code?: string }) => {
      // listen-time errors. EADDRINUSE is the common one — port 8765
      // already bound by a previous launch that didn't clean up, or
      // by an unrelated process. The caller (auth.ts) reports this
      // through the `error` SpotifyStatus variant.
      const message =
        err.code === 'EADDRINUSE'
          ? `spotify oauth: port ${LOOPBACK_PORT} in use`
          : `spotify oauth: server error: ${err.message}`;
      settle(() => {
        reject(new Error(message));
      });
    });

    server.listen(LOOPBACK_PORT, LOOPBACK_HOST);

    timer = setTimeout(() => {
      settle(() => {
        reject(new Error('spotify oauth: timeout'));
      });
    }, timeoutMs);
  });
}

/**
 * Plain HTML "you can close this tab" response. Status param is just
 * the HTTP code; body is built from a tiny inline template. Kept
 * trivial — no static asset, no template engine, no XSS surface
 * (heading and detail come from us, not from query params).
 */
function respondClosable(
  res: ServerResponse,
  status: number,
  heading: string,
  detail: string,
): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head>` +
      `<body style="font-family:system-ui;padding:2rem;background:#000;color:#fff">` +
      `<h1 style="font-weight:normal">${heading}</h1>` +
      `<p style="color:#A7A5A5">${detail}</p>` +
      `</body></html>`,
  );
}
