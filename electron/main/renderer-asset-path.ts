import { resolve, sep } from 'node:path';

/**
 * Result of resolving a renderer-asset URL path to an on-disk file.
 *
 * `ok: false, reason: 'traversal'` is the defense-in-depth case:
 * after normalizing the requested path against `rendererDir`, the
 * resolved absolute path falls outside `rendererDir`. The URL parser
 * already normalizes `..` segments in most cases — this check exists
 * for the edge cases where it doesn't, and for future bug-resistance.
 */
export type ResolveResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'traversal' };

/**
 * Resolve a URL pathname (e.g. `/index.html`, `/assets/foo.js`) to an
 * absolute file path inside `rendererDir`, rejecting any path that
 * escapes the directory.
 *
 * Empty pathname (and `/`) map to `index.html`, since these are the
 * document root.
 *
 * Used by the embedded localhost HTTP server in `renderer-server.ts`
 * to serve the renderer bundle in packaged builds. Extracted as a
 * pure function so the traversal check has a unit test
 * (`renderer-asset-path.test.ts`) — the server's request handler
 * itself isn't readily unit-testable as a whole, but its security-
 * critical input-validation step is, in isolation.
 *
 * Originally written for a `musaic-app://` custom-protocol path;
 * ported here unchanged after the move to the localhost HTTP
 * server.
 */
export function resolveAppAssetPath(
  rendererDir: string,
  urlPathname: string,
): ResolveResult {
  // Strip leading slashes; collapse to index.html when empty. The
  // URL parser normalizes the pathname so `/` and `//` both reach us
  // as some number of leading slashes; treat them uniformly.
  const stripped = urlPathname.replace(/^\/+/, '');
  const rel = stripped === '' ? 'index.html' : stripped;

  // resolve() is platform-aware (uses POSIX or Win32 separators
  // matching the current platform) and collapses any residual `.`
  // / `..` segments. Anything that survived URL normalization gets
  // collapsed here.
  const rendererAbs = resolve(rendererDir);
  const candidate = resolve(rendererAbs, rel);

  // Containment check. The candidate is allowed when it equals
  // rendererAbs exactly (impossible for a real asset, but tightens
  // the invariant) or sits underneath rendererAbs followed by a
  // separator. The trailing-separator check is what distinguishes
  // `/foo/bar` (inside `/foo`) from `/foobar` (sibling that happens
  // to share a prefix).
  if (
    candidate !== rendererAbs &&
    !candidate.startsWith(rendererAbs + sep)
  ) {
    return { ok: false, reason: 'traversal' };
  }

  return { ok: true, filePath: candidate };
}
