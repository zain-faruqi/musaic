/**
 * Just enough of import.meta.glob to typecheck our usage in
 * electron/main/db/index.ts.
 *
 * Pulling in `vite/client` types would also add `import.meta.hot` and
 * a pile of DOM-adjacent types into the main-process tree, which we
 * don't need. This declares the one signature we use; if we add more
 * glob shapes later, extend it here.
 */

interface ImportMeta {
  glob(
    pattern: string,
    options: {
      readonly query: '?raw';
      readonly import: 'default';
      readonly eager: true;
    },
  ): Record<string, string>;
}

/**
 * Castlabs Electron exposes a `components` API for managing the
 * Component Updater Service (Widevine CDM install/update). Stock
 * Electron doesn't export this. The module-augmentation here lets the
 * main process file (electron/main/index.ts) typecheck cleanly against
 * either distribution.
 *
 * Runtime behavior: on stock electron, the destructured `components`
 * is `undefined`. The `typeof components !== 'undefined'` guard in
 * electron/main/index.ts skips the call.
 *
 * Shape: matches what castlabs's docs/api/components.md describes:
 *   - whenReady(): Promise<void> — resolves when all components have
 *     finished installing/updating.
 *   - status(): Record<string, unknown> — opaque per-component status
 *     object; logged once on boot for diagnosis.
 *
 * If we ever ship code that depends on `components` being present,
 * tighten the type to non-optional. Today it's behind a guard.
 */
declare module 'electron' {
  interface Components {
    whenReady(): Promise<void>;
    status(): Record<string, unknown> | null;
  }
  // `const` declarations on the module augmentation pin the runtime
  // shape without forcing it non-optional at the call site (callers
  // still use a `typeof` guard).
  const components: Components | undefined;
}
