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

---
 
## User guide
 
### Connecting Spotify
 
The **Connect Spotify** pill lives in the top bar (right side). Click it, a browser window opens to Spotify's consent screen, approve, and the browser tab will show "you can close this window". Back in Musaic the pill will read `Spotify — <your email>` with a `Disconnect` action next to it. The token is stored encrypted in the macOS Keychain, so you only do this once.
 
If you ever need to switch Spotify accounts, click **Disconnect**, then **Connect Spotify** again with the other account.
 
### Adding music
 
Three ways, depending on source. They all land in the same `/ Recently Added` row on the home page.
 
**Local files** — two paths:
 
- Drop the file(s) into `~/Music/Musaic/` via Finder. A watcher in the app picks them up within a second or two. Subfolders are walked recursively.
- Click the **open file** pill on the home page, pick a file from anywhere on disk. The file is *copied* into `~/Music/Musaic/` (not just referenced), so you can move the original afterward without breaking anything.
Supported formats: `.mp3`, `.m4a`, `.aac`, `.flac`, `.wav`, `.ogg`, `.opus`. Metadata (title, artist, album art) comes from the file's embedded tags.
 
**YouTube** — paste a YouTube URL into the input pill labeled `paste a YouTube URL`, press Enter (or click `add`). The video gets saved as a tile in `/ Recently Added`. Some videos are rights-restricted and can't be embedded — those still save but show a warning; clicking them will surface that at play-time. No API key needed.
 
**Spotify** — paste a Spotify URL into the input pill labeled `paste a Spotify URL`, press Enter. Accepts:
 
- **Track URLs** → saves one tile
- **Playlist URLs** → imports every playable track in the playlist (paginated; up to 10,000)
- **Album URLs** → imports every track on the album
The library populates incrementally as pages come in, so for big playlists you'll see tiles appearing while the import is still running. Status reads `imported N tracks` when done. Requires Spotify to be connected first; if it isn't, the input will tell you so.
 
### Playing music
 
Click any tile to start playing it. The full row of tiles becomes the queue, with your clicked tile as the cursor — so clicking the third tile of a playlist plays from track 3, with tracks 4+ queued behind it.
 
The bar at the bottom of the window has:
 
- **Transport controls** (centered) — previous, play/pause, next
- **Scrubber** (under the controls) — click or drag to seek
- **Position readouts** (left and right of the scrubber) — current time / total time
- **Track info** (left side) — title, artist, source badge
- **Video panel** (toggles open for YouTube tracks) — the embedded player
Once any track has played at least once after launch, the OS-level controls light up: media keys (F7/F8/F9 or the function-row equivalents), AirPods double-tap and force-touch, the Control Center widget, the lock screen controls, and Bluetooth remotes — they all drive Musaic. This is the same "needs an active media session" behavior Spotify and Apple Music have; first launch needs one manual play to wake it up.
 
### Playlists
 
Click **+ New playlist** in the `/ Playlists` row header. A text input slides in — type the name, Enter to create, Escape to cancel. The playlist appears as a new tile in the row.
 
Click a playlist tile to open its detail page. From there:
 
- **Rename** — click the playlist name in the header. It becomes editable; Enter to save, Escape to cancel.
- **Add tracks** — click `+ Add tracks` in the header. A picker page opens with a grid of every track in your library (tracks already in the playlist are filtered out). Check the ones you want, click the sticky footer pill at the bottom to confirm. You can multi-select across local, YouTube, and Spotify tracks freely; they'll play back through their respective adapters automatically.
- **Remove a track** — hover any track tile; an `×` button appears. Click it; the button changes to confirm. Click again within 3 seconds to actually remove, or click anywhere else to cancel.
- **Delete the playlist** — `delete playlist` button in the header. Same 3-second confirm pattern as the per-track remove. Deletion removes the playlist row and its track memberships, but never the underlying tracks — those stay in your library.
Click any track tile inside a playlist to play from there, with the rest of the playlist queued behind it.
 
### Now Playing on the desktop
 
While Musaic is playing, the current track is published to macOS's Now Playing surface — Control Center widget, lock screen, AirPods controls. Title, artist, and album art come through; play/pause/next/prev/seek all work from those surfaces and drive Musaic's queue, including cross-source (a Spotify track can be queued after a local file, etc.).
