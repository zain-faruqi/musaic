# Musaic

Personal Electron app that unifies playback across Spotify, YouTube, and local files on macOS.

## Prerequisites

- **macOS** — the only supported platform
- **Node.js ≥ 20** ([nvm](https://github.com/nvm-sh/nvm) recommended)
- **Python 3** — needed by the castlabs signer
- **Homebrew** — for installing `pipx`
- **Spotify Premium** — the Web Playback SDK doesn't work on free accounts
- **Spotify Developer account** — free at [developer.spotify.com](https://developer.spotify.com/dashboard)
- **castlabs account** — free at [castlabs.com](https://castlabs.com/), needed because Spotify's DRM (Widevine) only works under [castlabs's Electron fork](https://github.com/castlabs/electron-releases), and the fork requires every packaged build to be VMP-signed by their EVS service before it can decrypt anything

## 1. Install the castlabs signer (one-time per machine)

Every `npm run package` build automatically VMP-signs the `.app` via an `afterPack` hook that shells out to castlabs's Python CLI. You need that CLI installed and authenticated once.

```bash
brew install pipx
pipx ensurepath          # re-open your shell after this so PATH picks up pipx
pipx install castlabs-evs
evs-vmp reauth           # creates / signs into your castlabs account
```

`reauth` walks you through signup if you don't have a castlabs account yet, then caches credentials so future packages don't prompt.

If you previously installed via `pip3 install --user castlabs-evs` that also works — the signing hook falls back to `python3 -m castlabs_evs.vmp`.

see more [castlabs-setup.md](https://github.com/zain-faruqi/musaic/blob/main/docs/castlabs-setup.md)

## 2. Spotify Developer app

1. Go to <https://developer.spotify.com/dashboard> → **Create app**
2. Name / description: anything
3. **Redirect URI**: `http://127.0.0.1:8765/callback` — must be the IP literal exactly, not `localhost`. Spotify deprecated `localhost` loopback redirects in November 2025.
4. APIs / services: check **Web API** and **Web Playback SDK**
5. Save, then copy the **Client ID** from the app's settings page

Spotify dev apps in development mode only let allowlisted accounts sign in, so either create your own dev app per above or ask me to add your Spotify account as a user on my existing app.

## 3. Clone & install

```bash
git clone https://github.com/zain-faruqi/musaic.git
cd musaic
npm install
```

The `postinstall` hook runs `scripts/repair-castlabs-install.sh`, which works around [castlabs issue #144](https://github.com/castlabs/electron-releases/issues/144) where `npm install` can silently leave a broken Electron framework. If you see castlabs-related errors during install, running `npm install` once more usually clears them.

## 4. Environment file

Create `.env.local` in the repo root:

```
VITE_SPOTIFY_CLIENT_ID=<your client id from step 2>
```

PKCE flow — no client secret needed.

## 5. Run

### Dev mode (hot reload, no packaging step)

```bash
npm run dev
```

Spotify works in dev because `node_modules/electron/dist/` is already the castlabs fork — no VMP signing needed for the unpackaged binary at this layer.

### Packaged build

```bash
npm run package
```

This runs `electron-vite build`, then `electron-builder --mac --arm64`, then the castlabs signer (via the `afterPack` hook). The build takes a few minutes; look for `[sign-vmp] OK` in the log to confirm the VMP signing step ran. If you don't see that line, Spotify playback won't work in the packaged app.

When it finishes, open `dist/` in Finder — or from the terminal:

```bash
open dist/Musaic-*-arm64.dmg
```

You'll see `Musaic-<version>-arm64.dmg` — double-click it (or use the `open` command above), drag `Musaic.app` to `Applications`, then eject the DMG. Launch from Applications going forward.

**First launch**: macOS will refuse to open the app because the build isn't signed with an Apple Developer cert yet ("Musaic can't be opened because Apple cannot check it for malicious software"). Right-click `Musaic.app` in Applications → **Open** → confirm the dialog. After that one-time bypass, normal double-clicks work.

The packaged-build database lives at `~/Library/Application Support/Musaic/`, separate from the dev database, so the library will look empty on first packaged launch. Local files in `~/Music/Musaic/` will re-index on first run; any saved YouTube tracks need to be re-pasted.

## Common failure modes

- **`evs-vmp: command not found`** — `pipx` PATH isn't set up. Run `pipx ensurepath` and open a new terminal.
- **`Not authed to EVS`** during `npm run package` — run `evs-vmp reauth`.
- **Electron framework 404 during package** — transient castlabs release issue; retry. If it persists, check that `electron-builder.yml`'s `electronDownload.mirror` matches the castlabs `electron` version in `package.json`.
- **Spotify "Invalid redirect URI"** when connecting — the dev-app redirect doesn't match. It has to be exactly `http://127.0.0.1:8765/callback`, no trailing slash, IP literal not `localhost`.
- **Packaged app launches but Spotify playback fails silently** — VMP signing was skipped or failed. Re-check the build log for the `[sign-vmp]` line; the `.app` won't decrypt Widevine content without it.

## Filesystem layout

- `~/Music/Musaic/` — local-file library. Drop files here to add them; an in-app watcher picks them up automatically.
- `~/Library/Application Support/Musaic/` — packaged-build SQLite database and encrypted Spotify token store.
- `~/Library/Caches/electron/` — cached Electron framework download (reused across packages).
