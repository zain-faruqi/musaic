/**
 * Type augmentation for `import.meta.env`. Mirrors the subset of
 * Vite's ImportMetaEnv that we actually use.
 *
 * Why not `"types": ["vite/client"]` in tsconfig.web.json: the full
 * vite/client types include CSS-module + asset-import declarations
 * that would conflict with our hand-written src/types/css-modules.d.ts
 * (different `default` typing). Declaring just `env.PROD` here keeps
 * the rest of our type setup intact.
 *
 * Supports the adapter factory's PROD-vs-DEV split.
 */

interface ImportMetaEnv {
  /**
   * `true` in production builds (`electron-vite build`), `false` in
   * dev (`electron-vite dev`). Used in src/core/create-adapter.ts to
   * pick between SpotifyAdapter (real) and MockSpotifyAdapter (dev).
   */
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
