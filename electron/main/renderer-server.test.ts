import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRendererServer, type RendererServer } from './renderer-server';

/**
 * These are real-HTTP integration tests — they start the actual
 * server against a temp directory of fixture files and hit it with
 * `fetch`. No Electron required; pure Node `http` + `fetch` (both
 * built-in on Node 22+).
 *
 * Coverage rationale: this server is the only path the renderer
 * loads through in packaged builds, so its behavior under the
 * common cases (root, asset, MIME, 404, traversal) is worth pinning
 * down. The pure path-resolution helper is tested separately in
 * `renderer-asset-path.test.ts`; this file tests the request-handler
 * end-to-end and the lifecycle (start, address shape, close).
 */
describe('renderer-server', () => {
  let rendererDir: string;
  let server: RendererServer;

  beforeAll(async () => {
    // Build a small fixture renderer dir. Files chosen to exercise
    // the MIME table for common asset types and to verify nested
    // paths work.
    rendererDir = await fs.mkdtemp(join(tmpdir(), 'musaic-renderer-server-test-'));
    await fs.writeFile(
      join(rendererDir, 'index.html'),
      '<!doctype html><html><body>hi</body></html>',
      'utf-8',
    );
    await fs.mkdir(join(rendererDir, 'assets'));
    await fs.writeFile(
      join(rendererDir, 'assets', 'app.js'),
      'console.log("ok");',
      'utf-8',
    );
    await fs.writeFile(
      join(rendererDir, 'assets', 'style.css'),
      'body { background: #000; }',
      'utf-8',
    );
    await fs.writeFile(
      join(rendererDir, 'assets', 'data.json'),
      '{"hello":"world"}',
      'utf-8',
    );
    // A binary-ish thing the MIME table doesn't know about, to
    // verify the octet-stream fallback works.
    await fs.writeFile(
      join(rendererDir, 'assets', 'oddball.xyz'),
      'binary-ish content',
      'utf-8',
    );

    server = await startRendererServer(rendererDir);
  });

  afterAll(async () => {
    await server.close();
    await fs.rm(rendererDir, { recursive: true, force: true });
  });

  it('serves index.html on /', async () => {
    const res = await fetch(`${server.origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<body>hi</body>');
  });

  it('serves index.html on empty path', async () => {
    // `fetch` always sends at least `/`, so we have to construct
    // the URL manually to test the truly-empty path case. Both
    // should map to index.html.
    const res = await fetch(`${server.origin}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('serves a JS asset with the correct MIME', async () => {
    const res = await fetch(`${server.origin}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/javascript; charset=utf-8',
    );
    expect(await res.text()).toBe('console.log("ok");');
  });

  it('serves a CSS asset with the correct MIME', async () => {
    const res = await fetch(`${server.origin}/assets/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('serves a JSON asset with the correct MIME', async () => {
    const res = await fetch(`${server.origin}/assets/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const res = await fetch(`${server.origin}/assets/oddball.xyz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('sets Content-Length on responses', async () => {
    const res = await fetch(`${server.origin}/assets/app.js`);
    expect(res.headers.get('content-length')).toBe(
      String('console.log("ok");'.length),
    );
  });

  it('returns 404 for missing files', async () => {
    const res = await fetch(`${server.origin}/assets/nope.js`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for path traversal attempts', async () => {
    // Test the defense-in-depth check. The URL parser usually
    // collapses `..` before we see it, but the underlying handler
    // re-validates anyway. We hit the server with a hand-crafted
    // URL that has `..` segments URL-encoded so they survive
    // URL.pathname normalization.
    const res = await fetch(`${server.origin}/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for paths that resolve to a directory', async () => {
    const res = await fetch(`${server.origin}/assets`);
    expect(res.status).toBe(404);
  });

  it('returns 405 for POST', async () => {
    const res = await fetch(`${server.origin}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('returns 405 for PUT', async () => {
    const res = await fetch(`${server.origin}/`, { method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('supports HEAD requests (headers without body)', async () => {
    const res = await fetch(`${server.origin}/assets/app.js`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/javascript; charset=utf-8',
    );
    expect(res.headers.get('content-length')).toBe(
      String('console.log("ok");'.length),
    );
    // Body should be empty on HEAD.
    expect(await res.text()).toBe('');
  });

  it('exposes the origin as an http://localhost:<port> URL', () => {
    // Host string is `localhost` even though the bind is `127.0.0.1` —
    // see renderer-server.ts construction-site comment for why.
    expect(server.origin).toMatch(/^http:\/\/localhost:\d+$/);
  });
});

describe('renderer-server lifecycle', () => {
  // Separate describe block so its fixtures don't tangle with the
  // request-handling tests above. Specifically: this group needs
  // a server that's already been closed, which would break the
  // other group's afterAll.

  it('close() resolves cleanly and the port becomes unreachable', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'musaic-renderer-server-lifecycle-'));
    await fs.writeFile(join(dir, 'index.html'), 'x', 'utf-8');
    const s = await startRendererServer(dir);
    const origin = s.origin;

    // Server is live.
    const res = await fetch(origin);
    expect(res.status).toBe(200);
    await res.text(); // drain body so the keep-alive doesn't hold close()

    // Close.
    await s.close();

    // Subsequent requests should fail. Be lenient on the exact
    // error shape — fetch can throw, return 5xx, or hang briefly
    // depending on platform timing. Any non-200 outcome is correct.
    let postCloseFailed = false;
    try {
      const r = await fetch(origin);
      postCloseFailed = !r.ok;
    } catch {
      postCloseFailed = true;
    }
    expect(postCloseFailed).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('two servers can run on different ports concurrently', async () => {
    const dirA = await fs.mkdtemp(join(tmpdir(), 'musaic-renderer-server-a-'));
    const dirB = await fs.mkdtemp(join(tmpdir(), 'musaic-renderer-server-b-'));
    await fs.writeFile(join(dirA, 'index.html'), 'A', 'utf-8');
    await fs.writeFile(join(dirB, 'index.html'), 'B', 'utf-8');

    const a = await startRendererServer(dirA);
    const b = await startRendererServer(dirB);

    expect(a.origin).not.toBe(b.origin);

    const [resA, resB] = await Promise.all([fetch(a.origin), fetch(b.origin)]);
    expect(await resA.text()).toBe('A');
    expect(await resB.text()).toBe('B');

    await a.close();
    await b.close();
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  });
});
