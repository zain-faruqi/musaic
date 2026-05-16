#!/usr/bin/env bash
# Musaic — scaffolding script
#
# Generates the M1 project skeleton — the target directory layout.
# Idempotent only insofar as it bails if package.json
# already exists; otherwise it overwrites.
#
# Run from the directory you want the project rooted in.
# Does NOT run `npm install` — review files first, then `npm install`.

set -euo pipefail

# --- Preflight -------------------------------------------------------------

if [[ -f "package.json" ]]; then
  echo "package.json already exists in this directory. Aborting to avoid clobbering."
  echo "Run from an empty directory, or delete package.json and re-run."
  exit 1
fi

echo "Scaffolding Musaic..."

# --- Directory layout ------------------------------------------------------

mkdir -p \
  electron/main/ipc \
  electron/main/nowplaying \
  electron/preload \
  src/adapters/local \
  src/adapters/youtube \
  src/adapters/spotify \
  src/core \
  src/db/migrations \
  src/ui/components \
  src/ui/layout \
  src/ui/pages \
  src/ui/hooks \
  src/ui/styles \
  src/state \
  src/types

# --- Root configs ----------------------------------------------------------

cat > package.json <<'EOF'
{
  "name": "musaic",
  "version": "0.0.0",
  "description": "Personal multimedia player unifying Spotify, YouTube, and local files on macOS.",
  "main": "out/main/index.js",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "chokidar": "^4.0.1",
    "keytar": "^7.9.0",
    "music-metadata": "^10.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.23.8",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "@vitejs/plugin-react": "^4.3.4",
    "electron": "^33.2.0",
    "electron-vite": "^2.3.0",
    "eslint": "^9.17.0",
    "eslint-plugin-react": "^7.37.2",
    "eslint-plugin-react-hooks": "^5.1.0",
    "globals": "^15.13.0",
    "prettier": "^3.4.2",
    "typescript": "^5.7.2",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  },
  "engines": {
    "node": ">=20"
  }
}
EOF

cat > tsconfig.json <<'EOF'
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
EOF

cat > tsconfig.node.json <<'EOF'
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["electron/**/*", "electron.vite.config.ts", "vitest.config.ts"]
}
EOF

cat > tsconfig.web.json <<'EOF'
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@renderer/*": ["src/*"]
    }
  },
  "include": ["src/**/*"]
}
EOF

cat > electron.vite.config.ts <<'EOF'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') },
      },
    },
  },
});
EOF

cat > vitest.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src'),
    },
  },
  test: {
    // Default to node; renderer tests can override per-file with
    // `// @vitest-environment jsdom` once jsdom is added as a devDep.
    environment: 'node',
    globals: false,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', 'out/**', 'dist/**'],
  },
});
EOF

cat > eslint.config.js <<'EOF'
// Flat config (ESLint 9). If something here misbehaves on first run,
// suspect this file before suspecting the lint rules themselves.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '*.config.js'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/exhaustive-deps': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
    settings: { react: { version: 'detect' } },
  },
];
EOF

cat > .prettierrc.json <<'EOF'
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
EOF

cat > .prettierignore <<'EOF'
node_modules/
out/
dist/
package-lock.json
EOF

cat > .editorconfig <<'EOF'
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
EOF

cat > .gitignore <<'EOF'
node_modules/
out/
dist/
.DS_Store
*.log
.env
.env.local
.vscode/settings.json
EOF

cat > .nvmrc <<'EOF'
22
EOF

# --- Electron main + preload ----------------------------------------------

cat > electron/main/index.ts <<'EOF'
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS-only build, but keep the standard quit
  // semantics for non-macOS dev runs.
  if (process.platform !== 'darwin') app.quit();
});
EOF

cat > electron/preload/index.ts <<'EOF'
import { contextBridge } from 'electron';

// IPC bridge surface. Channels land here as they are introduced;
// shapes are defined in electron/main/ipc/contracts.ts (Zod schemas)
// and imported by both main and preload to stay in sync.
contextBridge.exposeInMainWorld('musaic', {
  // empty in M1 scaffold
});

// Renderer-visible type. Augment as channels land.
export type MusaicBridge = Record<string, never>;

declare global {
  interface Window {
    readonly musaic: MusaicBridge;
  }
}
EOF

# --- Renderer entry --------------------------------------------------------

cat > src/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- TODO(scaffold): tighten CSP before M2.
         Spotify Web Playback SDK loads from sdk.scdn.co; YouTube IFrame
         loads from www.youtube.com. Both will need explicit allowances. -->
    <title>Musaic</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./renderer.tsx"></script>
  </body>
</html>
EOF

cat > src/renderer.tsx <<'EOF'
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui/styles/tokens.css';
import './ui/styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('renderer: #root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
EOF

cat > src/App.tsx <<'EOF'
import type { ReactElement } from 'react';

export const App = (): ReactElement => {
  return (
    <main>
      <h1>MUSAIC</h1>
    </main>
  );
};
EOF

# --- Core (types + constants) ---------------------------------------------

cat > src/core/types.ts <<'EOF'
/**
 * Source of a track. Discriminated-union-ready: switch on this and
 * let `never` catch missing cases.
 */
export type Source = 'local' | 'youtube' | 'spotify';

/**
 * Source-agnostic track shape used everywhere outside adapter internals.
 *
 * `sourceId` carries the platform-specific identifier (file path for
 * `local`, video id for `youtube`, spotify URI for `spotify`). Adapters
 * translate at their boundary; the rest of the app only sees this shape.
 *
 * Dedup priority: ISRC exact match → fuzzy match on
 * `title + primary artist + duration ±DEDUP_DURATION_TOLERANCE_MS`.
 */
export type UnifiedTrack = {
  readonly id: string;
  readonly source: Source;
  readonly sourceId: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly durationMs: number;
  readonly artwork?: string;
  readonly album?: string;
  readonly isrc?: string;
};

/**
 * Top-level playback state. Mirrors what the OS Now Playing widget needs.
 */
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/**
 * The PlaybackAdapter contract. Every source implements the full contract.
 *
 * Invariants:
 *   - `load` does not play. It prepares; volume is user-controlled.
 *   - Position is reported in milliseconds (never seconds).
 *   - On `unload`, all listeners / timers / polls are released.
 *   - Errors thrown or emitted include the source name in the message,
 *     e.g. `new Error('spotify: device not ready')`.
 *
 * NOTE(scaffold): the `on()` signature returns `void`, but with no
 * companion `off()` listeners can't be removed. Resolve before the
 * first adapter lands.
 */
export type PlaybackAdapter = {
  readonly source: Source;
  load(track: UnifiedTrack): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  unload(): Promise<void>;
  getPositionMs(): number;
  on(event: 'timeupdate', cb: (positionMs: number) => void): void;
  on(event: 'ended', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
};
EOF

cat > src/core/constants.ts <<'EOF'
/**
 * How early before track end to begin pre-warming the next adapter.
 * The next adapter's volume is held at 0 until handoff.
 *
 */
export const PRELOAD_LEAD_MS = 5_000;

/**
 * Spotify Web Playback SDK position polling interval.
 */
export const POLL_INTERVAL_SPOTIFY_MS = 250;

/**
 * YouTube IFrame Player API has no native timeupdate event, so the
 * youtube adapter polls getCurrentTime(). 200ms balances accuracy
 * against CPU.
 */
export const POLL_INTERVAL_YOUTUBE_MS = 200;

/**
 * Maximum time to wait for a new adapter to confirm it's playing during
 * a handoff before falling back to the gap path. Bounded by the 1.5s
 * cross-source gap target.
 */
export const HANDOFF_VERIFY_TIMEOUT_MS = 1_500;

/**
 * Tolerance window for the duration component of fuzzy dedup.
 */
export const DEDUP_DURATION_TOLERANCE_MS = 2_000;
EOF

# --- UI styles -------------------------------------------------------------

cat > src/ui/styles/tokens.css <<'EOF'
/*
 * Design tokens. The single source of truth for color and shape.
 * Hardcoded color literals (#fff, rgb(), etc.) anywhere in src/ui/
 * are a review-blocker.
 */
:root {
  --bg: #000000;          /* app background */
  --fg: #FFFFFF;          /* primary text, strokes, icons */
  --fg-muted: #A7A5A5;    /* secondary text: dates, subtitles, helpers */
  --fg-subtle: #D9D9D9;   /* tertiary, placeholder fills */

  /* Reserved. Do not consume in v1. The palette is monochrome.
     When a future version introduces a single accent (e.g. active
     source badge, scrub progress), set this once here and use it
     nowhere else. */
  --accent: unset;

  --stroke: 1px solid var(--fg);
  --radius-pill: 9999px;   /* search bar, filter chips, primary buttons */
  --radius-tile: 0;        /* album/video tiles are square */

  --font-sans: 'Inter', system-ui, sans-serif;

  /* Spacing scale — pick from these, don't sprinkle magic numbers. */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 40px;
}
EOF

cat > src/ui/styles/global.css <<'EOF'
*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

body {
  min-block-size: 100vh;
}

button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
}

a {
  color: inherit;
  text-decoration: none;
}
EOF

# --- .gitkeep in empty dirs ------------------------------------------------

touch \
  electron/main/ipc/.gitkeep \
  electron/main/nowplaying/.gitkeep \
  src/adapters/local/.gitkeep \
  src/adapters/youtube/.gitkeep \
  src/adapters/spotify/.gitkeep \
  src/db/migrations/.gitkeep \
  src/ui/components/.gitkeep \
  src/ui/layout/.gitkeep \
  src/ui/pages/.gitkeep \
  src/ui/hooks/.gitkeep \
  src/state/.gitkeep \
  src/types/.gitkeep

# --- Done ------------------------------------------------------------------

echo ""
echo "Scaffold complete."
echo ""
echo "Next steps:"
echo "  1. Review package.json — bump versions to latest if you want."
echo "  2. npm install"
echo "  3. npm run typecheck    # confirms TS is happy"
echo "  4. npm run dev          # opens an Electron window with 'MUSAIC'"
echo ""
echo "Known scaffold-time TODOs to resolve before they bite:"
echo "  - electron/preload/index.ts: bridge is empty until M1 IPC channels land."
echo "  - src/index.html:           CSP must be set before M2 (Spotify SDK + YT IFrame)."
echo "  - src/core/types.ts:        PlaybackAdapter.on() returns void — see NOTE(scaffold)."
