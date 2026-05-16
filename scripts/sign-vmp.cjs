// VMP (Verified Media Path) signing hook, invoked by electron-builder
// as the `afterPack` lifecycle step. Shells out to castlabs's EVS
// Python client to sign the packaged .app so Widevine's license
// server (which Spotify's DRM uses) will accept it.
//
// This file is plain CommonJS — electron-builder's lifecycle hooks
// load directly from disk at packaging time and do NOT run through
// the project's tsconfig or any transpilation. The `.cjs` extension
// is load-bearing: `package.json` declares `"type": "module"`, so a
// `.js` filename here would be loaded as ESM by Node, and the
// `require()` / `module.exports` shape below fails with
// "require is not defined in ES module scope". Same reason the
// preload bundle ships as `index.cjs` — see electron.vite.config.ts.
//
// Why this exists: castlabs's pre-signed dev VMP works against UAT
// license servers but Spotify rejects it (500 from
// `api.spotify.com/v1/widevine-license/v1/audio/license`). EVS
// production VMP signing is the documented unblock; the Python
// tool is the signing primitive, this JS file is glue.
//
// The reference integration pattern is multiboxlabs/flow-browser's
// signAppWithVMP() — same flow, same exit-code semantics.
//
// castlabs-evs Python tool".

// ESLint: `console` is not in the default global set for .cjs files
// under this project's flat config (the `**/*.{ts,tsx}` block is the
// only place that pulls in Node globals). Declare it locally rather
// than widen the eslint config; same pattern is acceptable for the
// other plain-Node scripts in this directory.
/* global console */

const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const SETUP_DOC = 'docs/castlabs-setup.md';

/** True iff `cmd` is on PATH. `which` exits non-zero when not found. */
function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = async function signVmp(context) {
  // context shape from electron-builder docs (afterPack):
  //   appOutDir          — directory holding the .app bundle
  //   packager.appInfo.productFilename — e.g. "Musaic" (no .app suffix)
  //   electronPlatformName — 'darwin' | 'win32' | 'linux'
  //
  // We only sign on macOS in this slice; Windows and Linux are not
  // build targets and Linux Widevine doesn't require VMP signing
  // (castlabs's EVS wiki). Bail early on anything else.
  if (context.electronPlatformName !== 'darwin') {
    console.log(
      `[sign-vmp] skipped: not macOS (platform=${context.electronPlatformName}).`,
    );
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  // We log the .app path for the user, but castlabs's sign-pkg
  // command takes the *parent directory*, not the .app itself.
  // From the EVS wiki:
  //   "path/to/package-directory means the path to the directory
  //    that contains your .app or .exe, NOT the path to the .app or
  //    .exe themselves."
  // Pass `context.appOutDir` (e.g. `dist/mac-arm64/`); the tool walks
  // it, finds Musaic.app, and signs the executables inside. Passing
  // the .app path directly yields "No matching executable found"
  // because sign-pkg looks for *another* .app inside what you gave it.
  //
  // Note on issue #77 (which warned against passing a parent dir
  // containing both .app and .dmg): the DMG doesn't exist yet at
  // afterPack time — it's created later — so there's no .dmg in
  // appOutDir to confuse the tool. The builder-effective-config.yaml
  // and any other non-binary files in the directory are walked past
  // since they aren't executables.
  console.log(`[sign-vmp] signing VMP on ${appPath}`);

  // Find a way to invoke the EVS signer. `castlabs-evs` exposes two
  // surfaces:
  //   - A console script `evs-vmp` on PATH. This is what pipx installs
  //     (the recommended path on modern macOS / Homebrew Python, where
  //     PEP 668 blocks the older `pip install castlabs-evs` form).
  //   - A module `python3 -m castlabs_evs.vmp`. This works when the
  //     package is installed into the same python3 that's on PATH,
  //     e.g. `pip3 install --user castlabs-evs` or `pip` in a venv.
  // Try the console-script form first (it's the install path docs
  // currently recommend); fall back to module form. If neither works,
  // point at both install options.
  //
  // Both forms get the parent directory (context.appOutDir), not the
  // .app path — see the long comment above the appPath construction
  // for why.
  let cmd;
  let args;
  if (commandExists('evs-vmp')) {
    cmd = 'evs-vmp';
    args = ['sign-pkg', context.appOutDir];
  } else if (commandExists('python3')) {
    cmd = 'python3';
    args = ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir];
  } else {
    throw new Error(
      `[sign-vmp] neither evs-vmp nor python3 is on PATH. ` +
        `VMP signing needs the castlabs-evs Python tool. ` +
        `Install with one of:\n` +
        `    brew install pipx && pipx install castlabs-evs   # recommended\n` +
        `    pip3 install --user castlabs-evs                  # alternative\n` +
        `See ${SETUP_DOC} for full setup steps.`,
    );
  }

  // Invoke the signer. `stdio: 'inherit'` so the user sees the tool's
  // progress (upload, signature request, verification) in the build
  // log as it happens — these steps take several seconds each and a
  // silent build is worse than a noisy one. The tool's own output is
  // much more informative than anything we'd synthesize.
  const result = spawnSync(cmd, args, { stdio: 'inherit' });

  if (result.error) {
    // spawn-level failure — e.g. command found by `command -v` but
    // disappeared between the check and the invocation. Surface the
    // underlying error message so the user sees what node actually
    // hit.
    throw new Error(
      `[sign-vmp] failed to spawn ${cmd}: ${result.error.message}. ` +
        `See ${SETUP_DOC} for setup.`,
    );
  }

  if (result.status !== 0) {
    // The Python tool printed its own diagnostic to the inherited
    // stderr already; our job is to point at the common causes and
    // fail the build loud enough that the user sees the link.
    throw new Error(
      `[sign-vmp] ${cmd} sign-pkg exited with code ${result.status}.\n` +
        `Common causes:\n` +
        `  1. Not signed in to EVS. Run:\n` +
        `       evs-account reauth     # if installed via pipx\n` +
        `       python3 -m castlabs_evs.account reauth     # if installed via pip\n` +
        `  2. castlabs-evs not installed. Run one of:\n` +
        `       brew install pipx && pipx install castlabs-evs   # recommended\n` +
        `       pip3 install --user castlabs-evs                  # alternative\n` +
        `  3. Network error reaching the EVS service.\n` +
        `See ${SETUP_DOC} for full setup steps.`,
    );
  }

  console.log(`[sign-vmp] OK: VMP signature applied to ${appPath}`);
};
