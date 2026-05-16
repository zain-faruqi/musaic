import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * electron-vite config.
 *
 * Three bundles produced into `out/{main,preload,renderer}/`. Main and
 * renderer stay ESM; preload is forced to CJS because Electron's
 * sandboxed preload context can't load ESM (see the inline comment on
 * the `preload` block below).
 *
 * Env vars (.env / .env.local): electron-vite calls `loadEnv` with the
 * Vite default prefix list `['VITE_']` per-bundle and injects matching
 * vars via `import.meta.env`. For the *main* bundle we want
 * `VITE_SPOTIFY_CLIENT_ID` to be readable at runtime through `process.env`
 * — that's how `electron/main/spotify/auth.ts` reads it — so we
 * explicitly substitute it via `define`. The renderer doesn't read this
 * variable at all; OAuth runs in main end-to-end.
 *
 * Vite picks up `.env.local` automatically; no special mode flag
 * is required.
 */
export default defineConfig(({ mode }) => {
  // Load all VITE_-prefixed env vars from .env / .env.local for this
  // mode. Loaded once and reused for the main `define` block below.
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      // Substitute the Spotify client ID into the main bundle at build
      // time. Without this, `process.env['VITE_SPOTIFY_CLIENT_ID']`
      // reads `undefined` in production: electron-vite's default env
      // handling targets `import.meta.env`, not `process.env`, and
      // electron-builder's packaged runtime doesn't have `.env.local`
      // sitting next to the main bundle to load at boot. `JSON.stringify`
      // on `undefined` yields the literal string "undefined" which the
      // clientIdOrThrow() guard would still catch — but quoting it
      // explicitly via `JSON.stringify(value ?? '')` matches Vite's
      // convention and produces a clean empty-string when the var is
      // unset (and clientIdOrThrow then throws with a clear message).
      define: {
        'process.env.VITE_SPOTIFY_CLIENT_ID': JSON.stringify(
          env['VITE_SPOTIFY_CLIENT_ID'] ?? '',
        ),
      },
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
          // Force CommonJS for preload. Electron's sandboxed preload
          // context can't load ESM (.mjs) — fails with "Cannot use import
          // statement outside a module" and silently leaves window.musaic
          // undefined. The .cjs extension is unambiguously CJS regardless
          // of package.json "type": "module".
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
          },
        },
      },
    },
    renderer: {
      root: resolve(__dirname, 'src'),
      plugins: [react()],
      resolve: {
        alias: {
          '@renderer': resolve(__dirname, 'src'),
          // IPC contracts cross the process boundary by design — renderer
          // imports the Zod schemas at runtime to validate responses.
          '@ipc': resolve(__dirname, 'electron/ipc'),
        },
      },
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/index.html') },
        },
      },
    },
  };
});
