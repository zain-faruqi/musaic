import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      // Renderer-side import shorthand. Unchanged by the migration.
      { find: '@renderer', replacement: resolve(__dirname, 'src') },

      // IPC contracts. Mirrors the alias in electron.vite.config.ts's
      // `renderer.resolve.alias` block. Production renderer code imports
      // Zod schemas at runtime to validate IPC responses
      // (defense-in-depth at the IPC boundary); Vitest needs the same
      // alias so renderer-side tests can import those same modules.
      { find: '@ipc', replacement: resolve(__dirname, 'electron/ipc') },

      // node:sqlite shim — only loaded under Vitest.
      // vite-node has a bug for experimental Node built-ins: its
      // `isNodeBuiltin` checks `module.builtinModules`, which
      // deliberately omits experimental modules. `sqlite` is one of
      // them, so vite-node decides `node:sqlite` is NOT a built-in,
      // strips the `node:` prefix via `normalizeModuleId`, and tries
      // to resolve `sqlite` on disk — failing with
      // "Failed to load url sqlite (resolved id: sqlite). Does the
      // file exist?". There's no config knob that prevents the strip
      // (the externalize check happens after normalization, by which
      // point the prefix is gone). vite-node has a hardcoded
      // `prefixedBuiltins` Set containing only `node:test` for the
      // same workaround.
      //
      // Aliasing `node:sqlite` to a local file sidesteps the bug:
      // vite-node loads the file from disk normally, and the file
      // uses `createRequire` to fetch the real built-in via Node's
      // own resolver. See test-shims/node-sqlite.mjs.
      //
      // Production (npm run dev / npm run build) is unaffected — this
      // alias is only in vitest.config.ts, not in electron.vite.config.ts.
      // electron-vite externalizes Node built-ins for the main bundle
      // via `externalizeDepsPlugin`, and `node:sqlite` works correctly
      // through that path.
      //
      // Removable when upstream vite-node adds `node:sqlite` to its
      // `prefixedBuiltins` Set; benign cleanup, not a blocker.
      {
        find: /^node:sqlite$/,
        replacement: resolve(__dirname, 'test-shims/node-sqlite.mjs'),
      },
    ],
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
