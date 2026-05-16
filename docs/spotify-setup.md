# Spotify Developer App setup

Musaic's Spotify integration requires a registered Spotify Developer
app and an active Spotify Premium subscription on the account you
plan to connect. The Web Playback SDK does not work on free
accounts.

The OAuth flow is bundled into the app — once setup is done, clicking
"Connect Spotify" in the app's `/ Connections` row handles consent
end-to-end.

## Steps

1. Sign in at <https://developer.spotify.com/dashboard> with your
   Spotify account. Free; no payment, no separate developer
   agreement beyond accepting the standard Developer Terms.

2. Click **Create app**. App name and description are arbitrary —
   "Musaic" is fine.

3. **Redirect URI** must be exactly:

       http://127.0.0.1:8765/callback

   The trailing path (`/callback`) matters. Add only this one URI.

   **Don't use `localhost`.** Spotify's November 2025 OAuth migration
   deprecated loopback redirects to `localhost`; the dashboard now
   only accepts `127.0.0.1` literals for HTTP redirect URIs. Using
   `localhost` will produce an `INVALID_CLIENT: Invalid redirect URI`
   error at the authorize endpoint.

4. Under **Which API/SDKs are you planning to use?**, check
   **Web Playback SDK**. (Web API is implied; you don't need to check
   it separately.)

5. Save. The dashboard now shows your **Client ID** on the app's
   settings page.

6. Copy the Client ID into a new file at the repo root named
   `.env.local`:

       VITE_SPOTIFY_CLIENT_ID=<paste-your-client-id-here>

   `.env.local` is gitignored. **No client secret** is needed —
   the OAuth flow uses PKCE (Proof Key for Code Exchange), which is
   also why this stays safe to keep in a single file at the repo
   root.

## What "Connect Spotify" does

When you click the **Connect Spotify** pill on the home page's
`/ Connections` row:

1. Main starts a one-shot HTTP server bound to `127.0.0.1:8765`.
2. Main opens your system browser to Spotify's consent page with a
   PKCE code challenge and a fresh state parameter.
3. You sign in to Spotify (if not already) and approve the requested
   scopes.
4. Spotify redirects to `http://127.0.0.1:8765/callback?code=…&state=…`.
   Main captures the code, validates state, shuts down the server,
   exchanges the code for tokens via PKCE (no client secret), and
   fetches `/me` to get the connected email.
5. Main encrypts the tokens via Electron's `safeStorage` (backed by
   the macOS Keychain) and writes them to
   `<userData>/spotify-tokens.enc`.
6. The Connections row flips to "Spotify — <email> · Disconnect".

Restarting the app preserves the connection — tokens are loaded from
disk and decrypted on first `getStatus()` call. The access token is
refreshed transparently when it's about to expire; you'll only see
the consent screen again if you Disconnect, the refresh token gets
revoked on Spotify's side, or you clear `<userData>`.

## Scopes requested

Musaic requests these scopes up front rather than progressively:

| Scope                          | What we use it for                          |
|--------------------------------|---------------------------------------------|
| `streaming`                    | Web Playback SDK                             |
| `user-read-playback-state`     | SDK player state polling                    |
| `user-modify-playback-state`   | `PUT /me/player/play` for queued tracks     |
| `user-read-email`              | Show your connected account on Connections  |
| `user-read-private`            | Account info Spotify requires alongside email|
| `playlist-read-private`        | Library mirror of your playlists             |
| `user-library-read`            | Library mirror of your saved tracks          |

One consent screen, all the scopes the slices will need. The
alternative — re-prompting at each slice — was rejected in favor of
the one-screen UX.

## If something goes wrong

- **`INVALID_CLIENT: Invalid redirect URI`** at the authorize endpoint
  → the redirect URI in your dashboard doesn't exactly match
  `http://127.0.0.1:8765/callback`. Common causes: trailing slash,
  using `localhost` instead of `127.0.0.1`, port typo. The error page
  shows you the URI Spotify received; compare character-by-character
  against the dashboard.

- **`VITE_SPOTIFY_CLIENT_ID is not set`** in the app's status error
  message → `.env.local` is missing or the variable isn't set in it.
  Check the file exists at the repo root, has the `VITE_` prefix,
  and that you restarted `npm run dev` after creating it.

- **Connect button shows "port 8765 in use"** → another process
  (often a previous launch of the app) has the port held. Quit any
  other instances and click Connect again. The implementation drops
  keepalive connections on close, so the port should release within
  a second of the previous flow ending.

- **`AUTH_REQUIRED` or "Please log in to use the Web Playback SDK"**
  → the SDK couldn't validate your account; verify
  Premium is active on the account you signed in with.

## Building a signed bundle

`npm run package` produces a VMP-signed `.dmg` ready for personal
distribution (see `docs/castlabs-setup.md` for EVS signing prereqs).
Run it the same way you would in dev — the Connect flow inside the
packaged app uses the same OAuth callback server on
`127.0.0.1:8765`. The packaged renderer is served over a different
port (the embedded localhost HTTP server) but the OAuth redirect is
fixed at 8765 because that's the dashboard registration.

The first time you launch a packaged build, macOS Gatekeeper will
quarantine the `.app`. Right-click → Open to bypass once; subsequent
launches are normal. (Once Apple Developer Program enrollment lands
in M3, the packaged build will be properly code-signed and notarized
and this step goes away.)

## Cleanup

To revoke Musaic's access entirely:

1. Click **Disconnect** in the app's Connections row. This clears the
   local tokens.
2. (Optional) Visit <https://www.spotify.com/account/apps/> and
   revoke "Musaic" from the list. This invalidates the refresh token
   on Spotify's side too. (Disconnect-from-app only clears the local
   copy; the refresh token remains valid on Spotify's records until
   either Spotify rotates it or you revoke from the web.)

You can keep the developer-dashboard app registration indefinitely —
Spotify imposes no cost or expiration on it.
