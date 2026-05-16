# Castlabs Electron setup

## Prerequisites (one-time, macOS)

Make sure these are working *before* running `npm install`. Any one
of them broken produces a confusing install failure that looks like
a project bug.

- **Node ≥ 22.12** — `.nvmrc` says 22. If you have `nvm`:
  `nvm use` (and `nvm install 22` first if you don't have it).
  Castlabs ≥ v42 and modern Electron tooling refuse to run on older
  Node; the `EBADENGINE` warnings are non-fatal but precede stranger
  downstream failures.
- **Working Xcode Command Line Tools** — needed when better-sqlite3
  falls back to source-compile (which happens whenever no prebuild
  matches your Node/Electron/arch combo, which is common for
  brand-new Electron majors). If `clang` is on PATH but the C++
  stdlib headers (`<climits>`, etc.) can't be found, the CLT install
  is in an inconsistent state. Two fixes, lighter to heavier:

  - **Env var override** (try first): set `SDKROOT` so clang finds
    the SDK-internal C++ stdlib:

        export SDKROOT=$(xcrun --show-sdk-path)
        export CPATH=$SDKROOT/usr/include
        export CPLUS_INCLUDE_PATH=$SDKROOT/usr/include/c++/v1

    Add to `~/.zshrc` to persist. Documented community workaround
    in WiseLibs/better-sqlite3 issue #1267.

  - **Full reinstall** (if env vars don't work):

        sudo rm -rf /Library/Developer/CommandLineTools
        sudo xcode-select --install   # accept the install prompt

## Installing for the dev build

The dev build doesn't need a working database, and the current
better-sqlite3 release (v12.10) can't compile against Electron 42's
V8 14. Bypass the rebuild:

    cd ~/musaic2
    MUSAIC_SPIKE=1 npm install

That env var tells `scripts/rebuild-natives.sh` to skip the
better-sqlite3 rebuild and the app's main process to skip database
init. The dev harness is reachable; the regular library + YouTube
flows are not. The better-sqlite3 incompatibility will need to be
resolved for real before the full feature set works.

## Why this exists

Spotify's Web Playback SDK plays DRM-protected audio via the Encrypted
Media Extensions (EME) API, which requires Google's Widevine Content
Decryption Module (CDM). Stock Electron's Chromium build does not
include production-signed Widevine — only the unsigned debug variant
that Spotify's license server rejects.

[Castlabs](https://github.com/castlabs/electron-releases) maintains
**Electron for Content Security (ECS)**, an Electron fork that ships
with production-signed Widevine. The `wvcus` variant uses Chromium's
Component Updater Service to install Widevine on first launch and
keep it current via background updates.

We use castlabs to obtain a signed CDM that Spotify's
`widevine-license` endpoint will accept end-to-end. Without it, the
Web Playback SDK fails at the license-acquisition step in packaged
builds.

## What's installed

The `electron` dependency in `package.json` points to castlabs's
GitHub release tag, not the npm registry:

    "electron": "https://github.com/castlabs/electron-releases#v33.4.11+wvcus"

Castlabs **does not publish to npm**. Their builds are GitHub releases
only, installed by npm via the git+url syntax. The package name on
disk is still `electron`, so `node_modules/electron/` looks like a
normal Electron install — just with `+wvcus` in the version string and
their Widevine-enabled binary in `dist/`.

Pinned to `v42.0.0+wvcus` — castlabs's current latest stable
(released 2026-05-07, on the actively-maintained v42 line).

We originally pinned to `v33.4.11+wvcus` to minimize Chromium
API drift from our prior stock pin (`^33.2.0`), but castlabs's v33
line has been unmaintained since 2025 and Google's component server
declined to issue Widevine to that binary identity — almost
certainly trust-chain rotation. The v42 bump resolves it at the
cost of eight Chromium majors of upstream drift. Pin to whatever
castlabs is actively maintaining at the time of the next bump.

## Installing

    npm install

That's it. npm clones the castlabs repo at the pinned tag and runs
their install script, which downloads the platform-specific Electron
framework binary (~110MB on macOS arm64) into `node_modules/electron/
dist/`. Slow on the first install, fast on subsequent ones (npm caches
the resolved tarball).

The postinstall (`scripts/rebuild-natives.sh`) then rebuilds
`better-sqlite3` against castlabs's Electron ABI. Castlabs's binary
ABI is identical to the upstream Electron release of the same
major.minor.patch — so `prebuild-install` finds the stock-Electron
prebuilt better-sqlite3 binary for darwin-arm64+electron-33 and uses
it. The script strips the `+wvcus` SemVer build-metadata suffix
before passing to `--target`; prebuild-install doesn't strip it
itself.

## The one runtime API difference

Castlabs adds a `components` module to the `electron` package that
manages the Widevine CDM via Chromium's Component Updater Service.
Before opening any `BrowserWindow`, wait for components to be ready:

    import { app, BrowserWindow, components } from 'electron';

    app.whenReady().then(async () => {
      await components.whenReady();
      // ...everything else, including creating the window
    });

Skipping the await races the window against CDM availability. The
Web Playback SDK iframe loads before Widevine is registered, then
license requests come back 500 from
`api.spotify.com/v1/widevine-license/v1/audio/license`. This looks
**identical** to "castlabs's signature is being rejected" but is
actually "we didn't wait for the CDM to install."

`electron/main/index.ts` does this with a `typeof components !==
'undefined'` guard, so the file still runs cleanly under stock
Electron if anyone ever briefly swaps back to upstream.

## First-launch behavior

On first launch (per OS user), Widevine installation runs in the
background. Order of operations:

1. `app.whenReady()` fires.
2. `components.whenReady()` initiates a Component Updater Service
   check.
3. If Widevine isn't installed: download from Google's component
   server. Typically a few seconds; longer on slow networks.
4. `components.whenReady()` resolves; `components.status()` shows
   the per-component install state.
5. `createWindow()` runs, the renderer loads, the SDK is ready to
   use Widevine.

Subsequent launches: same flow, but step 3 is "background update
check" instead of "install" — typically a few ms. **No user-facing UI
during install/update.** If first launch feels slow on a clean
profile, that's expected.

## Production VMP signing

For development builds, castlabs's `wvcus` variant ships pre-signed
for the Widevine Verified Media Path (VMP). No additional signing
needed; the dev binary works out of the box.

For **production distribution**, Widevine enforces VMP signing on
macOS and Windows. Castlabs provides a separate signing service called
EVS (Electron Verification Service) that requires:

- A free castlabs developer account.
- The `castlabs-evs` Python module installed locally.
- Authentication into the EVS service via that module.
- An `afterPack` hook in `electron-builder` (or equivalent in your
  packaging pipeline) that invokes the signer.

References:

- castlabs docs on EVS: <https://github.com/castlabs/electron-releases/wiki/EVS>
- An example integration pattern (Flow Browser):
  <https://deepwiki.com/multiboxlabs/flow-browser/10-electron-version-management>

This is out of scope for the current dev-build flow. The packaging
task treats VMP signing as part of "what's needed to ship a working
Spotify adapter" alongside the existing Apple notarization plan in
M3.

## Operational concerns to know about

- **Cadence**: castlabs releases track upstream Electron with a small
  delay (typically a few days). They do not patch every upstream patch
  release; they cherry-pick the security-relevant ones into a smaller
  set of supported branches. As of May 2026, actively maintained
  majors are v38, v39, v40, v41 (and v42 / v43-alpha pre-releases).
  v33 is no longer patched. Acceptable for local dev; for shipped
  builds, pin to a then-current maintained major.

- **No npm**: every Electron version bump is a `package.json` edit to
  the GitHub URL tag, not a `^x.y.z` bump. There is no `npm outdated`
  signal for castlabs upgrades — you watch the releases page or set
  up GitHub watch notifications.

- **Lockfile entries**: `package-lock.json` records the tarball URL
  and integrity hash for the GitHub release. Subsequent `npm
  install`s use the same tarball; cache hits work normally.

- **Component install is online-only on first run.** No air-gapped
  install. If a future v1 user has zero internet on first launch,
  the CDM won't install and Spotify playback won't work until they
  come online. Realistically not a problem for a Spotify-using app.

- **License jurisdiction**: castlabs's binaries embed Widevine licensed
  for use, not redistribution. Same restriction as Chrome itself. We
  ship the app, not Widevine — Chrome's Component Updater downloads
  the CDM to the user's machine on first launch. Personal use is
  unambiguously fine; redistribution scenarios would need to read
  castlabs's wiki and Widevine's terms.

## If something breaks

- **`npm install` hangs on the castlabs tarball download** — castlabs's
  release assets are ~120MB. Slow networks may need to retry; npm
  doesn't surface progress for git+url installs. Patience or a faster
  connection.

- **`Module '"electron"' has no exported member 'components'`** during
  typecheck — you're typechecking against stock Electron's types.
  Either: (a) the `npm install` swapped to castlabs but you didn't
  reload your TS server, or (b) someone reverted `package.json`. The
  module augmentation in `electron/types.d.ts` should make this
  resolve under either install; if it doesn't, ensure that file is
  included in `tsconfig.node.json`'s `include`.

- **`prebuild-install warn install No prebuilt binaries found
  (target=33.4.11+wvcus ...)`** — the `+wvcus` strip isn't running.
  Check `scripts/rebuild-natives.sh` — the
  `ELECTRON_VERSION="${RAW_ELECTRON_VERSION%%+*}"` line is what strips
  the build metadata. If you see this with a clean `target=33.4.11`
  (no `+wvcus`), the script is fine and the cause is "no prebuild
  available for your arch + Electron major" — `better-sqlite3`'s
  release page is the source of truth on what's available.

- **`castlabs components.whenReady failed: Failed to install
  required components`** in the terminal, with renderer-side
  `EMEError: No supported keysystem was found.` — the Widevine CDM
  didn't install/register for this session. Three causes, in order
  of probability:

  1. **First-launch registration glitch ([issue #118](https://github.com/castlabs/electron-releases/issues/118))** —
     CDM downloaded to disk but isn't usable this session. Quit
     the app fully (Cmd+Q), restart the dev server, retry.
     Subsequent launches typically pick up the install.

  2. **Stale castlabs version** — if you're on an unmaintained
     castlabs major (v33 is unmaintained since 2025), Widevine's
     trust chain may have rotated since castlabs last signed that
     binary. Bump the `electron` pin in `package.json` to a
     currently-maintained release (e.g.
     `https://github.com/castlabs/electron-releases#v41.1.1+wvcus`)
     and re-install. This may surface Chromium-API drift in the
     YouTube adapter and local audio paths; the trade-off is
     upstream drift cost versus access to maintained Widevine builds.

  3. **Component server unreachable** ([issue #35](https://github.com/castlabs/electron-releases/issues/35)) —
     network/proxy/firewall blocking
     `update.googleapis.com`. Check Console.app for component
     updater logs.

  The `electron/main/index.ts` catch block now logs the
  per-component `ComponentError[]` and the post-failure
  `components.status()`. Read those for the actual diagnostic; the
  generic top-level "Failed to install required components" is the
  ComponentsError wrapper and isn't itself actionable.

- **App crashes immediately on launch (or `npm test` fails) with a
  dyld error referencing `@rpath/Electron Framework.framework/
  Electron Framework`** — this is castlabs's
  [issue #144](https://github.com/castlabs/electron-releases/issues/144) /
  [#195](https://github.com/castlabs/electron-releases/issues/195),
  a long-standing extraction-corruption bug that affects all
  castlabs releases from v32.3.1+wvcus forward (including the v33
  line we pin to). The root cause is that something in npm's hook
  context causes `extract-zip` inside Electron's `install.js` to
  silently abort mid-extraction; the framework binary ends up
  missing. The maintainer's documented workaround is to re-run
  the same `install.js` *outside* npm's context, which succeeds.

  `scripts/rebuild-natives.sh` detects this condition (missing
  framework binary at the expected path on macOS) and auto-applies
  the workaround as Step 1 of its postinstall. Healthy installs
  see a no-op.

  If you ever see the dyld error in spite of the auto-repair, run
  manually:

      cd node_modules/electron
      rm -rf dist
      node install.js
      cd ../..
      bash scripts/rebuild-natives.sh

  And report (the auto-detection logic in the script may need to
  cover a path variant we missed).

## EVS prerequisites for signed builds

Production VMP signing (required before any packaged build can play
Spotify content
castlabs's EVS Python client on the machine that runs `npm run
package`. Do these once:

1. **Create a castlabs developer account** at
   <https://castlabs.com/developer-portal/>. Free; gives EVS access.

2. **Install the EVS client.** Recommended path on macOS with
   Homebrew Python (the default on Apple Silicon) is `pipx`, which
   installs Python CLIs into isolated environments and sidesteps the
   PEP 668 "externally-managed" error that Homebrew Python raises
   against `pip install`:

       brew install pipx
       pipx ensurepath          # adds ~/.local/bin to PATH; restart shell if prompted
       pipx install castlabs-evs

   Alternative if you don't want pipx and your Python install allows
   it:

       pip3 install --user castlabs-evs

   castlabs-evs is a Python 3.7+ module published on PyPI. The
   package ships two console scripts (`evs-account`, `evs-vmp`)
   *and* an importable module (`castlabs_evs`). Either invocation
   form below works depending on how you installed it.

3. **Sign up the machine with EVS**:

       evs-account signup                              # pipx install
       # or
       python3 -m castlabs_evs.account signup          # pip install

   Interactive prompt — e-mail, name, organization, account name,
   password, then a confirmation code sent to your email. The
   signing capability is account-bound to the machine that completes
   this step.

4. **Verify the session is active**:

       evs-account reauth                              # pipx install
       # or
       python3 -m castlabs_evs.account reauth          # pip install

   Should succeed without prompting. If it asks for credentials,
   complete the prompt and try `reauth` again.

Skip this and `npm run package` will fail at the `afterPack` hook
with a non-zero exit from `evs-vmp sign-pkg` (or
`castlabs_evs.vmp sign-pkg` on the pip path). The hook auto-detects
which invocation form is available and uses whichever it finds; its
error message names both install paths so the fix is one copy-paste.

## Building a signed bundle

Two commands, two outputs:

- `npm run package:dir` — builds and packages the unpacked `.app`
  only. Output: `dist/mac-arm64/Musaic.app`. Faster (no DMG step);
  use this for iteration.
- `npm run package` — full DMG build. Output: `dist/Musaic-<version>-
  arm64.dmg` plus the unpacked `dist/mac-arm64/Musaic.app`. Use this
  when you want a shareable installer or want to test the
  drag-to-Applications flow.

Both run the VMP signing hook (`scripts/sign-vmp.cjs`) against the
packaged `.app`. The hook calls out to `python3 -m castlabs_evs.vmp
sign-pkg` and streams its output to your terminal — expect a few
seconds of "uploading binary", "verifying", "signing" lines from the
Python tool. The hook prints `[sign-vmp] OK: ...` on success.

**Opening the result on your Mac.** Because we don't macOS-code-sign
in this slice (`mac.identity: null` in `electron-builder.yml`),
Gatekeeper will quarantine the .app on first launch. Two options:

- **Right-click → Open.** macOS shows a "developer can't be verified"
  prompt with an "Open" button; click it. The grant is per-app and
  persistent across subsequent launches.
- **System Settings → Privacy & Security → "Open Anyway"**, after
  attempting to launch normally and being denied.

This will go away when macOS code signing lands in M3. VMP signing
is
separate and orthogonal — it goes inside the binary and Apple's
quarantine machinery has no opinion on it.

## Re-authenticating with EVS

EVS sessions expire after some inactivity. The signing hook will
fail with "exited with code 1" and the tool's own output will
include an auth error. Refresh the session:

    evs-account reauth                            # pipx install
    # or
    python3 -m castlabs_evs.account reauth        # pip install

Then re-run `npm run package`. The signing step picks up the new
session without rebuilding any of the JS output.

## More troubleshooting

- **`npm install` fails with `ERR_REQUIRE_ESM` while the postinstall
  script is running `node install.js`**, and the npm output above it
  shows `EBADENGINE` warnings naming Node `>=22.12.0` as required —
  you're on an older Node. Castlabs Electron 42's install.js does
  `require('@electron/get')`, which is ESM-only in v5+ and needs
  Node ≥ 22.12. The project's `.nvmrc` pins 22 for exactly this
  reason. Fix:

      nvm install 22         # if you don't have it
      nvm use                # picks up .nvmrc
      node -v                # confirm v22.x

  Then **clean the failed install** before retrying — the
  partially-installed castlabs framework will otherwise persist
  through subsequent `npm install`s:

      rm -rf node_modules package-lock.json
      npm install

- **`npm run package` fails with a 404 from the Electron download
  step.** Two flavors:

  - URL is `https://github.com/electron/electron/releases/...` —
    electron-builder is pulling from upstream electron, which has
    no `+wvcus` builds. `electron-builder.yml` needs an
    `electronDownload.mirror` pointing at castlabs.
  - URL is `https://github.com/castlabs/electron-releases/releases/download/vv42.0.0+wvcus/...`
    (note the **double-v**) — the mirror has a trailing `v` that
    electron-builder 26.x doesn't want. customDir is already
    v-prefixed by the @electron/get integration; drop the trailing
    `v` from the mirror. Older community examples for
    electron-builder v22 had the trailing v and are now stale.

  Correct form for current electron-builder:

      electronDownload:
        mirror: https://github.com/castlabs/electron-releases/releases/download/

  If the config is right and you still see a stale URL in the
  error, clear `~/Library/Caches/electron/` to discard any cached
  download attempt and retry.

- **`[sign-vmp] neither evs-vmp nor python3 is on PATH.`** — neither
  invocation form is available. Install `castlabs-evs` per the "EVS
  prerequisites" section above (pipx recommended). If `python3` is
  genuinely missing, install via Homebrew (`brew install python3`)
  or the Python.org installer first.

- **`[sign-vmp] <tool> sign-pkg exited with code 1.`** — the EVS
  signer ran but failed. Its own stderr printed to the terminal
  just above this message; that's the actual cause. The three most
  common ones the hook calls out explicitly:
  1. **Not signed in to EVS.** Run `evs-account reauth` (pipx) or
     `python3 -m castlabs_evs.account reauth` (pip) and re-package.
  2. **castlabs-evs not installed.** Run
     `brew install pipx && pipx install castlabs-evs` (recommended)
     or `pip3 install --user castlabs-evs`, then re-package.
  3. **Network error reaching EVS.** Same shape as any other
     network-bound CLI failure; usually retry-able.

- **`ModuleNotFoundError: No module named 'castlabs_evs'` from
  `python3` even though `pipx install castlabs-evs` succeeded** —
  pipx puts each tool in its own isolated environment, so the
  system `python3` doesn't see anything pipx installed. Use
  `evs-vmp` / `evs-account` instead (which pipx puts on PATH), or
  install via `pip3 install --user castlabs-evs` if you specifically
  want the `python3 -m castlabs_evs.*` form to work. The hook
  handles both — this only matters when you're running EVS commands
  by hand.

- **DMG creation fails with a Python or `hdiutil` error after
  signing succeeds** — `mac.identity: null` should prevent
  electron-builder from invoking codesign on the .app, but some
  electron-builder versions still call `hdiutil` to assemble the
  DMG and that step can hit unrelated macOS quirks. The
  unpacked `.app` in `dist/mac-arm64/` is still valid and runnable
  even if DMG assembly fails. `npm run package:dir` skips the DMG
  step entirely if you want to bypass it.
