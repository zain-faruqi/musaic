/**
 * Auth orchestrator tests.
 *
 * The two interesting decisions in this module are:
 *   - refresh-on-soon-to-expire vs return-cached, and
 *   - refresh-failure clears tokens and emits status-changed.
 *
 * Both are testable by stubbing `tokens.ts` (load/save/clear) and
 * `global.fetch`. The OAuth-server + PKCE bits are exercised in their
 * own test files; here we mock them out so the auth module can be
 * driven without standing up real HTTP.
 *
 * The `connect()` happy path is also unit-tested, but with the
 * loopback server, browser opener, and fetch all stubbed — the
 * integration "does this end-to-end against real Spotify" is
 * covered separately.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ----- Module mocks -----

// tokens.ts: we want to control load/save/clear without actually
// touching Electron's safeStorage. Each test installs the cached
// token state and asserts against the recorded calls.

const tokensState = {
  current: null as
    | null
    | {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        scope: string;
      },
};

vi.mock('./tokens', () => ({
  loadTokens: vi.fn(async () => tokensState.current),
  saveTokens: vi.fn(async (t: typeof tokensState.current) => {
    tokensState.current = t;
  }),
  clearTokens: vi.fn(async () => {
    tokensState.current = null;
  }),
}));

// oauth-server: tests for the callback server live in oauth-server.test.ts.
// Here we just stub `startCallbackServer` per-test so connect() can be
// driven end-to-end without HTTP.
vi.mock('./oauth-server', () => ({
  startCallbackServer: vi.fn(),
  REDIRECT_URI: 'http://127.0.0.1:8765/callback',
}));

// pkce: deterministic outputs make the assertions readable. The real
// PKCE is tested in pkce.test.ts.
vi.mock('./pkce', () => ({
  generateVerifier: vi.fn(() => 'verifier-fixed'),
  challengeFromVerifier: vi.fn(async () => 'challenge-fixed'),
  generateState: vi.fn(() => 'state-fixed'),
}));

// Imports MUST come after vi.mock calls.
import {
  connect,
  disconnect,
  getAccessToken,
  getStatus,
  onStatusChanged,
} from './auth';
import * as tokensModule from './tokens';
import * as oauthModule from './oauth-server';

const loadTokensMock = vi.mocked(tokensModule.loadTokens);
const saveTokensMock = vi.mocked(tokensModule.saveTokens);
const clearTokensMock = vi.mocked(tokensModule.clearTokens);
const startCallbackServerMock = vi.mocked(oauthModule.startCallbackServer);

// Stub global fetch per-test. Vitest's `vi.stubGlobal` is the documented
// API for this; cleared via `vi.unstubAllGlobals()` after each test.

beforeEach(async () => {
  tokensState.current = null;
  loadTokensMock.mockClear();
  saveTokensMock.mockClear();
  clearTokensMock.mockClear();
  startCallbackServerMock.mockReset();
  vi.unstubAllGlobals();
  process.env['VITE_SPOTIFY_CLIENT_ID'] = 'client-id-for-tests';
  // Reset auth module state (cachedEmail in particular — it persists
  // across tests at module scope and would leak the email from a
  // prior 'connected' assertion into a later cold-load assertion).
  // disconnect() is idempotent: it clears tokens (already null here)
  // and nulls cachedEmail. The status-changed emit it triggers is
  // harmless because no listeners are subscribed at this point.
  await disconnect();
  clearTokensMock.mockClear();
});

// ----- Helpers -----

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function mockFetch(
  responder: (url: string, init?: RequestInit) => FetchResponse,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      return responder(url, init);
    }),
  );
}

const okJson = (body: unknown): FetchResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const failure = (status: number, text: string): FetchResponse => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => text,
});

// ----- Tests -----

describe('getStatus', () => {
  it('returns disconnected when no tokens are stored', async () => {
    expect(await getStatus()).toEqual({ kind: 'disconnected' });
  });

  it('returns connected with the cached email after a successful connect', async () => {
    tokensState.current = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      scope: 'streaming',
    };
    // cachedEmail is module-scoped — we drive it by running a connect
    // flow which populates it. Simulate connect by populating tokens
    // directly and then doing a /me-backed status read.
    mockFetch((url) => {
      if (url.includes('/me')) return okJson({ email: 'a@b.com' });
      return failure(404, 'unexpected URL');
    });

    expect(await getStatus()).toEqual({
      kind: 'connected',
      email: 'a@b.com',
    });
  });

  it('clears tokens and returns disconnected when /me fails on cold lookup', async () => {
    // Tokens present but /me rejects — simulates revoked-on-website.
    tokensState.current = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      scope: 'streaming',
    };
    mockFetch(() => failure(401, 'invalid'));

    const status = await getStatus();
    expect(status).toEqual({ kind: 'disconnected' });
    expect(clearTokensMock).toHaveBeenCalled();
  });
});

describe('getAccessToken', () => {
  it('returns null when no tokens are stored', async () => {
    expect(await getAccessToken()).toBeNull();
  });

  it('returns the cached token when it has plenty of life left', async () => {
    tokensState.current = {
      accessToken: 'cached-access',
      refreshToken: 'r',
      // Well above the 30s refresh-lead threshold.
      expiresAt: Date.now() + 10 * 60 * 1000,
      scope: 'streaming',
    };
    // No fetch should be made — fail loudly if it is.
    mockFetch(() => failure(500, 'should not have been called'));
    expect(await getAccessToken()).toBe('cached-access');
  });

  it('refreshes when the cached token is within the refresh-lead window', async () => {
    tokensState.current = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      // 10s remaining — under the 30s threshold; refresh inline.
      expiresAt: Date.now() + 10_000,
      scope: 'streaming',
    };
    mockFetch((url, init) => {
      if (url.includes('accounts.spotify.com/api/token')) {
        // Refresh-token grant — confirm we sent the grant_type and
        // the existing refresh token.
        const body = (init?.body as URLSearchParams).toString();
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=old-refresh');
        return okJson({
          access_token: 'new-access',
          expires_in: 3600,
          scope: 'streaming',
          token_type: 'Bearer',
          // Spotify sometimes rotates; sometimes doesn't. This test
          // covers rotation; the no-rotation case is the next one.
          refresh_token: 'new-refresh',
        });
      }
      return failure(404, 'unexpected URL');
    });

    expect(await getAccessToken()).toBe('new-access');
    // Persist the new token (and the rotated refresh token).
    expect(saveTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      }),
    );
  });

  it('keeps the old refresh token when refresh response omits one', async () => {
    tokensState.current = {
      accessToken: 'old',
      refreshToken: 'keep-this',
      expiresAt: Date.now() + 5_000,
      scope: 'streaming',
    };
    mockFetch(() =>
      okJson({
        access_token: 'newer',
        expires_in: 3600,
        scope: 'streaming',
        token_type: 'Bearer',
        // No `refresh_token` here — the documented "not rotating" case.
      }),
    );

    expect(await getAccessToken()).toBe('newer');
    expect(saveTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: 'keep-this',
      }),
    );
  });

  it('clears tokens and returns null when refresh fails', async () => {
    tokensState.current = {
      accessToken: 'old',
      refreshToken: 'revoked',
      expiresAt: Date.now() + 5_000,
      scope: 'streaming',
    };
    mockFetch(() => failure(400, 'invalid_grant'));

    // Subscribe so we can confirm status-changed fires.
    let signals = 0;
    const off = onStatusChanged(() => {
      signals += 1;
    });
    try {
      expect(await getAccessToken()).toBeNull();
    } finally {
      off();
    }
    expect(clearTokensMock).toHaveBeenCalled();
    expect(signals).toBe(1);
  });
});

describe('disconnect', () => {
  it('clears stored tokens and emits status-changed', async () => {
    tokensState.current = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      scope: 'streaming',
    };
    let signaled = false;
    const off = onStatusChanged(() => {
      signaled = true;
    });
    try {
      await disconnect();
    } finally {
      off();
    }
    expect(clearTokensMock).toHaveBeenCalled();
    expect(signaled).toBe(true);
    expect(await getStatus()).toEqual({ kind: 'disconnected' });
  });
});

describe('connect — concurrency', () => {
  it('rejects a second concurrent connect with "oauth in progress"', async () => {
    // First connect "hangs" on the callback server — we control when
    // it settles via this deferred. The second connect should reject
    // immediately with the in-progress error before we even resolve
    // the deferred.
    let releaseFirst: () => void = () => undefined;
    startCallbackServerMock.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        releaseFirst = () => {
          reject(new Error('test-cleanup'));
        };
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>(
      async () => undefined,
    );
    const first = connect(openBrowser);

    // Yield to the event loop so the first connect advances past
    // `inflightConnect = …` before the second call sees it.
    await new Promise((r) => setTimeout(r, 5));

    await expect(connect(openBrowser)).rejects.toThrow(/in progress/);

    // Clean up — release the hung first connect so the module's
    // `inflightConnect` flag goes back to null. Otherwise subsequent
    // tests in this file see "oauth in progress" from the dangling
    // state. We expect this to reject (we rigged the deferred to
    // throw 'test-cleanup'); swallow that rejection here.
    releaseFirst();
    await expect(first).rejects.toThrow(/test-cleanup/);
  });
});

describe('connect — happy path', () => {
  it('completes the full flow: callback → exchange → /me → save → status', async () => {
    // Callback returns a code; the rest is fetch behavior.
    startCallbackServerMock.mockResolvedValueOnce({
      kind: 'code',
      code: 'auth-code-123',
    });

    mockFetch((url, init) => {
      if (url.includes('accounts.spotify.com/api/token')) {
        const body = (init?.body as URLSearchParams).toString();
        // Exchange-time body should carry the code + verifier (PKCE).
        expect(body).toContain('grant_type=authorization_code');
        expect(body).toContain('code=auth-code-123');
        expect(body).toContain('code_verifier=verifier-fixed');
        return okJson({
          access_token: 'first-access',
          refresh_token: 'first-refresh',
          expires_in: 3600,
          scope: 'streaming user-read-email',
          token_type: 'Bearer',
        });
      }
      if (url.includes('/me')) {
        return okJson({ email: 'user@example.com' });
      }
      return failure(404, `unexpected ${url}`);
    });

    const openBrowser = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    let signals = 0;
    const off = onStatusChanged(() => {
      signals += 1;
    });
    try {
      const status = await connect(openBrowser);
      expect(status).toEqual({ kind: 'connected', email: 'user@example.com' });
    } finally {
      off();
    }

    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser.mock.calls[0]?.[0]).toContain(
      'accounts.spotify.com/authorize',
    );
    expect(saveTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'first-access',
        refreshToken: 'first-refresh',
      }),
    );
    expect(signals).toBe(1);
  });

  it('surfaces user-denied as { kind: "error" } without persisting tokens', async () => {
    startCallbackServerMock.mockResolvedValueOnce({
      kind: 'error',
      error: 'access_denied',
      description: 'user denied',
    });
    // No fetch needed — we never reach the token endpoint.
    mockFetch(() => failure(500, 'should not be called'));

    const openBrowser = vi.fn(async () => undefined);
    const status = await connect(openBrowser);
    expect(status).toEqual({ kind: 'error', message: 'user denied' });
    expect(saveTokensMock).not.toHaveBeenCalled();
  });

  it('throws if VITE_SPOTIFY_CLIENT_ID is unset', async () => {
    delete process.env['VITE_SPOTIFY_CLIENT_ID'];
    const openBrowser = vi.fn(async () => undefined);
    await expect(connect(openBrowser)).rejects.toThrow(/VITE_SPOTIFY_CLIENT_ID/);
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
