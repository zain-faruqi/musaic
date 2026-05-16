#!/usr/bin/env bash
# Postinstall: repair castlabs's Electron install if npm corrupted
# the zip extraction.
#
# Castlabs issue #144 — under some npm execution contexts the
# `extract-zip` step inside Electron's install.js silently aborts
# mid-extraction, leaving the macOS framework binary missing.
# Symptom is an immediate dyld crash on launch or test:
#     Library not loaded: @rpath/Electron Framework.framework/Electron Framework
# The maintainer's documented workaround is to re-run `install.js`
# outside npm's hook context, which succeeds. The block below detects
# the missing framework binary on macOS and applies that workaround.
# It's a no-op on healthy installs and on non-macOS platforms.
#
# Extracted from the former scripts/rebuild-natives.sh when the
# better-sqlite3 → node:sqlite migration removed that script's second
# job (native module rebuild). The install-repair half stayed; it's
# unrelated to the database engine choice.
set -e

ELECTRON_DIST="node_modules/electron/dist"
ELECTRON_PATH_TXT="node_modules/electron/path.txt"
# Two paths to check on macOS, both must resolve for dyld to be happy:
#   - Top-level: a symlink at .framework/Electron Framework pointing
#     into Versions/Current/Electron Framework. This is what dyld
#     actually follows (@rpath/Electron Framework.framework/Electron
#     Framework). On a broken install this symlink can be missing
#     even when the binary at Versions/A/ exists; the dyld error
#     looks identical to "binary missing".
#   - Underlying binary: Versions/A/Electron Framework. The real file.
# `[ -f ]` follows symlinks, so a broken symlink at the top-level path
# fails the test cleanly. We check both because the failure mode can
# go either way and we don't want to claim a healthy install when
# only one of the two paths is right.
#
# `path.txt` exists when castlabs's install.js has completed; missing
# means the entire install never ran (a third silent-failure mode of
# the same #144 bug, where install.js exits 0 without doing anything).
FRAMEWORK_TOP_MAC="$ELECTRON_DIST/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
FRAMEWORK_BIN_MAC="$ELECTRON_DIST/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"

framework_broken() {
  [ ! -f "$ELECTRON_PATH_TXT" ] || [ ! -f "$FRAMEWORK_TOP_MAC" ] || [ ! -f "$FRAMEWORK_BIN_MAC" ]
}

if [ "$(uname)" = "Darwin" ] && [ -d "node_modules/electron" ] && framework_broken; then
  # Single-line message on the success path — the user just sees an
  # install step; the issue #144 detail is implementation noise and
  # only matters in the failure branch below.
  echo "Installing castlabs Electron framework..."
  (
    cd node_modules/electron
    rm -rf dist
    node install.js > /dev/null
  )
  if framework_broken; then
    # Re-extraction didn't fix it. Now the verbose detail earns its
    # keep — print everything we know so the user can diagnose or
    # paste it into a bug report.
    echo "ERROR: castlabs Electron framework install failed."
    echo "Detected state (castlabs issue #144 pattern):"
    echo "  path.txt present:           $([ -f "$ELECTRON_PATH_TXT" ] && echo yes || echo no)"
    echo "  top-level framework path:   $([ -f "$FRAMEWORK_TOP_MAC" ] && echo yes || echo no)"
    echo "  Versions/A binary present:  $([ -f "$FRAMEWORK_BIN_MAC" ] && echo yes || echo no)"
    echo "Try manually: cd node_modules/electron && rm -rf dist && node install.js"
    exit 1
  fi
fi
