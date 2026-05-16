import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { resolveAppAssetPath } from './renderer-asset-path';

// Tests are platform-agnostic by construction — `path.resolve()` uses
// whichever separator matches the current platform, and the helper
// uses the same `resolve()` internally. The renderer directory used
// in tests is an absolute path on the running OS; on macOS / Linux
// that's `/tmp/...`, which is fine for our purposes.
const RENDERER_DIR = resolve('/tmp/musaic-test-renderer');

describe('resolveAppAssetPath', () => {
  it('maps empty pathname to index.html', () => {
    const r = resolveAppAssetPath(RENDERER_DIR, '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filePath).toBe(resolve(RENDERER_DIR, 'index.html'));
  });

  it('maps root "/" to index.html', () => {
    const r = resolveAppAssetPath(RENDERER_DIR, '/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filePath).toBe(resolve(RENDERER_DIR, 'index.html'));
  });

  it('maps "/index.html" to the index file', () => {
    const r = resolveAppAssetPath(RENDERER_DIR, '/index.html');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filePath).toBe(resolve(RENDERER_DIR, 'index.html'));
  });

  it('maps a nested asset path to the right file', () => {
    const r = resolveAppAssetPath(RENDERER_DIR, '/assets/index-abc.js');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filePath).toBe(resolve(RENDERER_DIR, 'assets/index-abc.js'));
    }
  });

  it('rejects `..` segments that escape the renderer directory', () => {
    // Tests for defense in depth: even if URL parsing didn't already
    // collapse these, the path resolution would still reject them.
    // Passed in raw to simulate "what if the URL parser let one slip
    // through".
    const r = resolveAppAssetPath(RENDERER_DIR, '/../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('traversal');
  });

  it('rejects deeply nested `..` traversal', () => {
    const r = resolveAppAssetPath(RENDERER_DIR, '/../../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('traversal');
  });

  it('rejects sibling directory prefix-match attacks', () => {
    // If `RENDERER_DIR` is `/tmp/musaic-test-renderer`, a request that
    // resolves to `/tmp/musaic-test-renderer-evil/...` shares the
    // prefix but is a sibling, not a child. The trailing-separator
    // check in resolveAppAssetPath is what makes this distinction.
    const siblingDir = RENDERER_DIR + '-evil';
    const r = resolveAppAssetPath(RENDERER_DIR, `/../${siblingDir.split(sep).pop()}/data.txt`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('traversal');
  });

  it('allows paths that include `..` but stay inside renderer dir', () => {
    // `/assets/../index.html` collapses to `/index.html` — still inside.
    // This is the case that URL parsing handles naturally but is worth
    // testing as a sanity check that we don't over-reject.
    const r = resolveAppAssetPath(RENDERER_DIR, '/assets/../index.html');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filePath).toBe(resolve(RENDERER_DIR, 'index.html'));
  });

  it('collapses redundant slashes', () => {
    const r = resolveAppAssetPath(RENDERER_DIR, '///assets//foo.js');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filePath).toBe(resolve(RENDERER_DIR, 'assets/foo.js'));
    }
  });
});
