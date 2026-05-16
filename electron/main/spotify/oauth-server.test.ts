/**
 * OAuth callback server tests — real HTTP integration tests against
 * the loopback server.
 *
 * Each test starts the server, fires a real `fetch` against
 * `127.0.0.1:8765`, and awaits the result. End-to-end coverage
 * against real Spotify lives separately; these tests cover the local
 * branches we want to pin down for regressions:
 *
 *   - happy path (code + matching state)
 *   - state mismatch
 *   - error param from Spotify
 *   - missing code + missing error (contract violation)
 *   - timeout
 *   - non-/callback path is a no-op (server stays open)
 *
 * Port conflict (EADDRINUSE) isn't tested here because the runner
 * doesn't reliably guarantee port-8765 isolation across parallel
 * test files; the behavior is short and the surface is small.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  startCallbackServer,
  LOOPBACK_HOST,
  LOOPBACK_PORT,
} from './oauth-server';

const BASE = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`;

/**
 * Tracks in-flight promises so afterEach can drain any that didn't
 * settle naturally — tests that throw mid-await won't have closed
 * their server otherwise.
 */
const pendingPromises = new Set<Promise<unknown>>();

/**
 * Each test starts and awaits its own server. The settled promise
 * also closes the server, so afterEach has nothing to clean up in
 * the happy cases — it exists as a safety net for assertions that
 * throw before the server settles.
 *
 * The afterEach delay gives the OS time to reclaim port 8765 between
 * tests. Without it, even with `closeAllConnections()`, the kernel
 * can hold the port in TIME_WAIT briefly and the next test's
 * `server.listen(8765)` hits EADDRINUSE. 50ms is generous; the
 * actual window is typically <10ms on Linux/macOS.
 */
afterEach(async () => {
  pendingPromises.clear();
  await new Promise((r) => setTimeout(r, 50));
});

const track = <T>(p: Promise<T>): Promise<T> => {
  pendingPromises.add(p);
  p.finally(() => pendingPromises.delete(p)).catch(() => {
    /* swallowed; outer awaits the rejection */
  });
  return p;
};

describe('startCallbackServer', () => {
  it('resolves with { kind: "code" } on a matching state + code', async () => {
    const state = 'matching-state-abc123';
    const pending = track(startCallbackServer({ state, timeoutMs: 2000 }));

    // Server listens asynchronously; give Node's event loop a tick so
    // the socket is bound before we fetch against it. Using `fetch`'s
    // retry-on-connect isn't worth the loop here.
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${BASE}/callback?code=ABCDEF&state=${state}`);
    expect(res.status).toBe(200);

    const result = await pending;
    expect(result).toEqual({ kind: 'code', code: 'ABCDEF' });
  });

  it('rejects with state-mismatch when state does not match', async () => {
    const pending = track(
      startCallbackServer({ state: 'expected', timeoutMs: 2000 }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${BASE}/callback?code=X&state=different`);
    expect(res.status).toBe(400);

    await expect(pending).rejects.toThrow(/state mismatch/);
  });

  it('resolves with { kind: "error" } when Spotify returns an error param', async () => {
    const state = 'denied-flow';
    const pending = track(startCallbackServer({ state, timeoutMs: 2000 }));
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(
      `${BASE}/callback?error=access_denied&error_description=user%20denied&state=${state}`,
    );
    expect(res.status).toBe(200);

    const result = await pending;
    expect(result).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'user denied',
    });
  });

  it('resolves with { kind: "error" } when error has no description', async () => {
    // error_description is documented as recommended-but-optional in
    // the OAuth 2 error response shape. Confirm the result shape
    // omits description rather than including `undefined`.
    const state = 'errflow';
    const pending = track(startCallbackServer({ state, timeoutMs: 2000 }));
    await new Promise((r) => setTimeout(r, 20));

    await fetch(`${BASE}/callback?error=invalid_scope&state=${state}`);

    const result = await pending;
    expect(result).toEqual({ kind: 'error', error: 'invalid_scope' });
    // exactOptionalPropertyTypes: confirm key is absent, not
    // present-with-undefined.
    expect('description' in (result as object)).toBe(false);
  });

  it('rejects when both code and error are missing (Spotify contract violation)', async () => {
    const state = 'empty-redirect';
    const pending = track(startCallbackServer({ state, timeoutMs: 2000 }));
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${BASE}/callback?state=${state}`);
    expect(res.status).toBe(400);

    await expect(pending).rejects.toThrow(/missing both code and error/);
  });

  it('rejects on timeout', async () => {
    // Generously short window — test passes in ~50ms on a healthy
    // runner. Fire-and-forget; nothing makes a callback request.
    const pending = track(
      startCallbackServer({ state: 'never-arrives', timeoutMs: 30 }),
    );
    await expect(pending).rejects.toThrow(/timeout/);
  });

  it('ignores requests to paths other than /callback', async () => {
    // Loopback noise / browser preflights / favicon — we don't want
    // any of these to settle the promise. The server should respond
    // 404 and keep listening; the real /callback request that comes
    // later resolves normally.
    const state = 'noise-then-real';
    const pending = track(startCallbackServer({ state, timeoutMs: 2000 }));
    await new Promise((r) => setTimeout(r, 20));

    const noise = await fetch(`${BASE}/favicon.ico`);
    expect(noise.status).toBe(404);

    const real = await fetch(`${BASE}/callback?code=Y&state=${state}`);
    expect(real.status).toBe(200);

    const result = await pending;
    expect(result).toEqual({ kind: 'code', code: 'Y' });
  });

  it('closes the server after settling (happy path)', async () => {
    const state = 'cleanup-check';
    const pending = track(startCallbackServer({ state, timeoutMs: 2000 }));
    await new Promise((r) => setTimeout(r, 20));

    await fetch(`${BASE}/callback?code=Z&state=${state}`);
    await pending;

    // After the server has settled and closed, a fetch should be
    // refused (ECONNREFUSED → fetch rejects). Use a short delay so
    // close() has time to actually release the socket.
    await new Promise((r) => setTimeout(r, 30));
    await expect(fetch(`${BASE}/callback?code=ignored`)).rejects.toThrow();
  });

  it('closes the server after settling (timeout)', async () => {
    await expect(
      track(startCallbackServer({ state: 'will-time-out', timeoutMs: 30 })),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    await expect(fetch(`${BASE}/callback?code=ignored`)).rejects.toThrow();
  });
});
