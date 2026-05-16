import { LOCAL_FILE_PROTOCOL } from '@renderer/core/constants';

/**
 * Convert a filesystem path to a `musaic-file://` URL the renderer can
 * assign to <audio>.src or <video>.src.
 *
 * The URL includes an explicit `localhost` authority. Chromium's URL
 * parser for schemes registered with `standard: true` (we need that for
 * streaming + range requests) requires a non-empty authority. Without
 * one, it normalizes `scheme:///path` by promoting the first path
 * segment to the authority and lowercasing it — for `/Users/...` paths
 * this turns the URL into `musaic-file://users/...` and the file is
 * lost. The localhost authority sidesteps the entire issue.
 *
 * Main's protocol handler uses `url.pathname`, which is identical
 * regardless of authority, so no main-side change is needed to round-trip.
 */
export const pathToLocalFileUrl = (filePath: string): string => {
  // Normalize to / separators (mostly defensive — macOS paths already are).
  const normalized = filePath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  const encoded = withLeadingSlash
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${LOCAL_FILE_PROTOCOL}://localhost${encoded}`;
};
