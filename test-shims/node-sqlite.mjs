// Shim used only at test time. Aliased into `node:sqlite` via
// vitest.config.ts so vitest-imports-`node:sqlite` resolve here
// instead of going through vite-node's transform pipeline.
//
// Why this exists:
//   vite-node has a bug for experimental Node built-ins. Its
//   `isNodeBuiltin` (in vite-node/dist/utils.mjs) checks against
//   `module.builtinModules`, which deliberately omits experimental
//   modules — `sqlite` is one of them. So vite-node decides
//   `node:sqlite` is NOT a built-in, calls `normalizeModuleId(id)`
//   which strips the `node:` prefix to `sqlite`, and then tries to
//   resolve `sqlite` as an on-disk module — which fails with
//   `Failed to load url sqlite (resolved id: sqlite). Does the file
//   exist?` There's no Vitest/Vite config knob that prevents the
//   strip; vite-node has a hardcoded `prefixedBuiltins` Set
//   containing only `node:test` for the same workaround.
//
//   This shim sidesteps the bug: vitest.config.ts aliases
//   `node:sqlite` to this file path, vite-node loads the file from
//   disk normally, and the file uses `createRequire` to fetch the
//   real built-in through Node's own resolver (which handles
//   `node:`-prefixed built-ins correctly regardless of whether they
//   appear in `builtinModules`).
//
// Production (npm run dev / npm run build) is unaffected: this file
// is only referenced by the test config's alias, never bundled into
// main / preload / renderer.
//
// When upstream vite-node adds `node:sqlite` to its
// `prefixedBuiltins` Set, this shim + the vitest.config.ts alias can
// be removed; benign cleanup, not a blocker.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('node:sqlite');

export const DatabaseSync = mod.DatabaseSync;
// Re-export anything else node:sqlite ships in case future code uses
// it (Session, Statement type, etc.).
export default mod;
