import type { MusaicBridge } from '@ipc/contracts';

/**
 * Ambient declaration so renderer code knows that `window.musaic` exists
 * and what shape it has. The bridge is installed by the preload script
 * via contextBridge.exposeInMainWorld; this file exists purely so tsc
 * picks up the type in the renderer project.
 */
declare global {
  interface Window {
    readonly musaic: MusaicBridge;
  }
}

export {};
