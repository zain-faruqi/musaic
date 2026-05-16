/**
 * Spotify auth orchestration.
 *
 * Composes the pieces (PKCE, OAuth loopback, token storage, fetch
 * against Spotify's auth and Web API endpoints) into a four-call
 * surface: `connect`, `disconnect`, `getAccessToken`, `getStatus`.
 *
 * State invariants:
 *   - At most one `connect()` flow in flight at a time. A second
 *     concurrent call rejects with "oauth in progress" rather than
 *     starting a second loopback server. The browser-window-opens-
 *     twice case from a double-click is the obvious motivator.
 *   - Tokens stored ⇔ connected. `disconnect` clears tokens. A failed
 *     refresh (revoked on Spotify's side, etc.) also clears tokens
 *     and emits status-changed.
 *   - `getAccessToken` is the read-through accessor. If the cached
 *     access token has <REFRESH_LEAD_MS remaining, refresh inline.
 *   - `getStatus` is read-only — it never refreshes, never network-
 *     hits. The renderer's connect button reads from here; we don't
 *     want page-load to trigger a refresh.
 *
 * Status broadcast: this module exposes a tiny pub/sub
 * (`onStatusChanged` / `emitStatusChanged`) so the IPC layer can wire
 * the `spotify:status-changed` push channel without taking a hard
 * dependency on BrowserWindow here.
 */
import {
  generateState,
  generateVerifier,
  challengeFromVerifier,
} from './pkce';
import {
  startCallbackServer,
  REDIRECT_URI,
  type CallbackResult,
} from './oauth-server';
import {
  loadTokens,
  saveTokens,
  clearTokens,
  type StoredTokens,
} from './tokens';
import type { SpotifyMeResponse, SpotifyTokenResponse } from './types';

// ---------- Endpoints / constants ----------

const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me';

/**
 * Refresh lead time: if the cached access token has fewer than this
 * many milliseconds left until `expiresAt`, getAccessToken refreshes
 * before returning. Spotify access tokens last 3600s; 30s of lead
 * means a token returned now is good for at least 30s of API work,
 * which covers SDK init plus a typical play-call without rotation.
 */
const REFRESH_LEAD_MS = 30_000;

/**
 * Scopes requested at the authorize endpoint. Requested up front
 * rather than progressively, by locked decision: one consent screen
 * is better UX than re-prompting on each slice.
 *
 * The adapter needs `streaming` + `user-read-playback-state`
 * + `user-modify-playback-state`. The library mirror needs
 * `playlist-read-private` + `user-library-read`. Email / account info
 * for the connected-account display needs `user-read-email` +
 * `user-read-private`.
 */
const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-email',
  'user-read-private',
  'playlist-read-private',
  'user-library-read',
] as const;

// ---------- SpotifyStatus shape (mirrors channels.ts) ----------

/**
 * Public connection state. Identical to the type in
 * electron/ipc/channels.ts — kept duplicated here so the auth module
 * doesn't need to import the IPC contract surface (separation of
 * concerns: auth doesn't know what gets broadcast where).
 *
 * The IPC contract's Zod schema validates that this shape stays in
 * sync at the boundary; any drift surfaces as a parse error on the
 * outbound IPC.
 */
export type SpotifyStatus =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly email: string }
  | { readonly kind: 'error'; readonly message: string };

// ---------- Module state ----------

/**
 * In-flight connect promise. Non-null while a connect attempt is
 * underway; nulled on settle (success or failure). Used to reject
 * a second concurrent connect rather than starting a second loopback
 * server.
 */
let inflightConnect: Promise<SpotifyStatus> | null = null;

/**
 * Cached email from the most recent /me lookup. Avoids a network
 * round-trip on every `getStatus` call. Populated on successful
 * connect, cleared on disconnect. Stale until next connect/refresh,
 * which is fine for our use (the user's email doesn't change between
 * tokens).
 */
let cachedEmail: string | null = null;

// ---------- Status broadcast (pub/sub) ----------

type StatusListener = () => void;
const statusListeners = new Set<StatusListener>();

/**
 * Register a callback to fire after any status change (connect,
 * disconnect, refresh-failure). Signal-only — the listener re-fetches
 * via `getStatus` to learn the new state. Matches the
 * `library:changed` bridge shape.
 *
 * Returns an unsubscribe function. Same shape as
 * PlaybackAdapter.on / library.onChanged.
 */
export function onStatusChanged(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

function emitStatusChanged(): void {
  for (const cb of statusListeners) {
    try {
      cb();
    } catch (err) {
      // A misbehaving listener should not break the others. Log; move on.
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('spotify auth: status listener threw:', msg);
    }
  }
}

// ---------- Internal helpers ----------

/**
 * Read VITE_SPOTIFY_CLIENT_ID at call time (not module load) so the
 * env var is observed regardless of when electron-vite or the runtime
 * populated it. Throws if missing — the caller surfaces this as a
 * SpotifyStatus error.
 */
function clientIdOrThrow(): string {
  const id = process.env['VITE_SPOTIFY_CLIENT_ID'];
  if (id === undefined || id.length === 0) {
    throw new Error(
      'spotify auth: VITE_SPOTIFY_CLIENT_ID is not set. ' +
        'Create .env.local at the repo root per docs/spotify-setup.md.',
    );
  }
  return id;
}

/**
 * POST to Spotify's token endpoint. Used for both the initial code
 * exchange and refresh-token grants. Body is URL-encoded per the
 * OAuth 2.0 spec.
 */
async function postToTokenEndpoint(
  body: URLSearchParams,
): Promise<SpotifyTokenResponse> {
  const resp = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(unreadable body)');
    throw new Error(
      `spotify auth: token endpoint ${resp.status}: ${text || '(empty)'}`,
    );
  }
  // Spotify always returns JSON for both 2xx and most 4xx responses
  // on this endpoint. Cast to the documented shape; the caller doesn't
  // introspect anything beyond the typed fields.
  return (await resp.json()) as SpotifyTokenResponse;
}

/**
 * GET /me for the connected account email. Surfaced on the
 * Connections row.
 */
async function fetchEmail(accessToken: string): Promise<string> {
  const resp = await fetch(SPOTIFY_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(unreadable body)');
    throw new Error(
      `spotify auth: /me ${resp.status}: ${text || '(empty)'}`,
    );
  }
  const me = (await resp.json()) as SpotifyMeResponse;
  return me.email;
}

/**
 * Convert a token-endpoint response to the StoredTokens shape we
 * persist. `expires_in` (seconds, relative) becomes `expiresAt` (ms,
 * absolute) so subsequent expiry checks are simple wall-clock compares
 * regardless of how long the value has been sitting in storage.
 *
 * On refresh, Spotify *may* rotate the refresh token; when it doesn't,
 * the caller passes in the existing refresh token so we don't lose it.
 */
function toStoredTokens(
  resp: SpotifyTokenResponse,
  fallbackRefreshToken: string | null,
): StoredTokens {
  const refresh = resp.refresh_token ?? fallbackRefreshToken;
  if (refresh === null) {
    throw new Error(
      'spotify auth: token response had no refresh_token and no fallback to reuse',
    );
  }
  return {
    accessToken: resp.access_token,
    refreshToken: refresh,
    // expires_in is seconds-from-now; Date.now() + expires_in*1000 is
    // ms-since-epoch wall-clock.
    expiresAt: Date.now() + resp.expires_in * 1000,
    scope: resp.scope,
  };
}

// ---------- Public surface ----------

/**
 * Begin a connect flow. Implements:
 *   1. Generate verifier + challenge + state.
 *   2. Start the loopback callback server.
 *   3. Open the system browser to Spotify's authorize URL.
 *   4. Await the redirect; reject on state mismatch.
 *   5. Exchange the code for tokens.
 *   6. Fetch /me to get the connected email.
 *   7. Persist tokens.
 *   8. Emit status-changed.
 *
 * Concurrency: holds an in-flight flag. Second concurrent call rejects
 * with `oauth in progress` rather than starting a second flow.
 *
 * `openBrowser` is injected so tests can drive the flow without
 * shelling out. Default implementation opens via `shell.openExternal`,
 * but the function takes it as a parameter so the IPC handler can
 * swap in for tests or special-case behavior. (See registerSpotifyHandlers
 * in electron/main/ipc/spotify.ts for the production wiring.)
 */
export async function connect(
  openBrowser: (url: string) => Promise<void>,
): Promise<SpotifyStatus> {
  if (inflightConnect !== null) {
    // Surface to the IPC handler, which will translate this into a
    // SpotifyStatus error — the renderer's connecting UI already
    // covers the visible state.
    throw new Error('spotify auth: oauth in progress');
  }

  inflightConnect = runConnect(openBrowser);
  try {
    return await inflightConnect;
  } finally {
    inflightConnect = null;
  }
}

/**
 * Internal `connect` body. Separated so the inflight wrapper above
 * can `await` it cleanly without nesting concerns.
 */
async function runConnect(
  openBrowser: (url: string) => Promise<void>,
): Promise<SpotifyStatus> {
  const clientId = clientIdOrThrow();

  const verifier = generateVerifier();
  const challenge = await challengeFromVerifier(verifier);
  const state = generateState();

  // Build the authorize URL. Spaces inside the scope param are encoded
  // by URLSearchParams as `+`, which Spotify accepts (it's the
  // application/x-www-form-urlencoded equivalent of `%20` in query
  // strings).
  const authUrl = new URL(SPOTIFY_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('state', state);

  // Start the loopback server BEFORE opening the URL. If we opened
  // the browser first, a fast user (or pre-consented account) could
  // redirect back before our listener was bound. The same ordering
  // caught no live race in earlier exploration, but the cost of
  // correct ordering
  // is zero so we keep it.
  const callbackPromise = startCallbackServer({ state });
  await openBrowser(authUrl.toString());

  // Await the redirect. Rejections here (state mismatch / timeout /
  // missing-code-and-error / port-in-use) propagate to the IPC handler,
  // which translates them into SpotifyStatus.error for the renderer.
  const callback: CallbackResult = await callbackPromise;

  if (callback.kind === 'error') {
    // User denied consent, invalid_scope, etc. Translate to a
    // SpotifyStatus error variant directly here — these are user-
    // visible outcomes, not programmer errors.
    return {
      kind: 'error',
      message: callback.description ?? callback.error,
    };
  }

  // Exchange the code for tokens. PKCE means no client secret.
  const exchangeBody = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const tokenResp = await postToTokenEndpoint(exchangeBody);
  const tokens = toStoredTokens(tokenResp, null);

  // Fetch /me before persisting so we don't end up in a state where
  // we have tokens but no email to display. If /me fails the user is
  // effectively disconnected — we throw, leaving tokens unsaved.
  const email = await fetchEmail(tokens.accessToken);

  await saveTokens(tokens);
  cachedEmail = email;
  emitStatusChanged();

  return { kind: 'connected', email };
}

/**
 * Clear stored tokens and emit status-changed. No revoke call —
 * Spotify doesn't expose programmatic token revocation; the user
 * revokes via their account page if they want to.
 */
export async function disconnect(): Promise<void> {
  await clearTokens();
  cachedEmail = null;
  emitStatusChanged();
}

/**
 * Read-only status accessor. The renderer's connect UI reads from
 * here on first mount and on each status-changed signal. Never
 * network-hits, never refreshes — page load shouldn't trigger token
 * rotation.
 *
 * If we have stored tokens but no cached email (cold launch after a
 * previous connect persisted), `getAccessToken` is what'll re-fetch
 * /me on its next call. Until then `getStatus` returns connected
 * with a placeholder email derived from "(loading)" so the UI doesn't
 * flash "Connect Spotify" momentarily — but the simpler and more
 * honest path is to refetch /me here on cold load and cache the
 * result. Done below.
 */
export async function getStatus(): Promise<SpotifyStatus> {
  const tokens = await loadTokens();
  if (tokens === null) {
    return { kind: 'disconnected' };
  }

  // Have tokens but no cached email — cold launch after a previous
  // connect. Fetch /me to populate the cache. Failure here means the
  // tokens are stale/revoked; treat as disconnected and clean up so
  // the next status check is fast.
  if (cachedEmail === null) {
    try {
      // Use a fresh-or-refreshed token. /me works against any valid
      // access token; if the access token expired, getAccessToken
      // refreshes it.
      const token = await getAccessToken();
      if (token === null) {
        return { kind: 'disconnected' };
      }
      cachedEmail = await fetchEmail(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('spotify auth: cold /me lookup failed:', msg);
      // Tokens present but unusable — clear them so the user sees
      // disconnected (and getAccessToken below won't keep retrying).
      await clearTokens();
      cachedEmail = null;
      // Don't emit status-changed here — getStatus is read-only;
      // surfacing the cleanup as a state event would race with the
      // very call that observed it.
      return { kind: 'disconnected' };
    }
  }
  return { kind: 'connected', email: cachedEmail };
}

/**
 * Return a current access token, refreshing if it's about to expire.
 * Returns null if no tokens are stored or refresh fails (in which
 * case we also clear the stored tokens and emit status-changed so
 * the renderer flips back to disconnected).
 *
 * The renderer calls this via the `spotify:get-token` IPC; the future
 * SDK callback uses the renderer's wrapper around it. Adapter
 * territory (3a-iii) — this slice only proves the call works end-to-
 * end via devtools.
 */
export async function getAccessToken(): Promise<string | null> {
  const tokens = await loadTokens();
  if (tokens === null) return null;

  // Soon-to-expire? Refresh inline. Returning a token that expires in
  // 5s and then fails on the very next call would just push the
  // refresh into the adapter layer — better to do it here, once, where
  // the rest of the policy lives.
  if (tokens.expiresAt - Date.now() > REFRESH_LEAD_MS) {
    return tokens.accessToken;
  }

  try {
    const clientId = clientIdOrThrow();
    const refreshBody = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    });
    const resp = await postToTokenEndpoint(refreshBody);
    // Spotify returns a new refresh_token *sometimes*. If they didn't,
    // keep using the one we have.
    const next = toStoredTokens(resp, tokens.refreshToken);
    await saveTokens(next);
    return next.accessToken;
  } catch (err) {
    // Refresh failure usually means the user revoked access on
    // Spotify's website, or the refresh token has been rotated out
    // from under us. Either way the stored tokens are unusable;
    // clear them and notify so the renderer flips back to
    // disconnected.
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('spotify auth: refresh failed, clearing tokens:', msg);
    await clearTokens();
    cachedEmail = null;
    emitStatusChanged();
    return null;
  }
}
