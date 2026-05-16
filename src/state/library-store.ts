import { create } from 'zustand';
import type { UnifiedTrack } from '@renderer/core/types';
import { listLibrary } from './library';

/**
 * Renderer-side mirror of the local-library index.
 *
 * Same pattern as player-store: a single module-level subscription
 * to a long-lived source (here, `window.musaic.library.onChanged`
 * over IPC) drives a Zustand store. The store and the IPC bridge
 * have equal lifetimes — the renderer process owns both, so the
 * subscription doesn't need an unsubscribe path.
 *
 * The initial fetch is kicked off at module load, not in a component
 * effect, so the home view doesn't need its own `useEffect` to start
 * loading the library (no useEffect for derived state, and
 * module-init subscriptions over per-component subscriptions where
 * the lifetime is the whole renderer).
 */
type LibraryState = {
  readonly tracks: readonly UnifiedTrack[];
  /**
   * True while the very first fetch is in flight. Subsequent
   * refreshes (triggered by library:changed) keep the previous
   * tracks visible — flicker-free swap — so loading stays false
   * after the initial load resolves.
   */
  readonly loading: boolean;
  /**
   * The most recent fetch error, if any. Surfaced for diagnostic
   * purposes; the UI doesn't yet do anything with it but the field
   * is here so a future error banner has a place to read from.
   */
  readonly error: string | null;
  readonly actions: {
    refresh(): Promise<void>;
  };
};

/**
 * Test seam — the actual subscription only attaches when running in
 * the renderer (where `window.musaic` exists). Vitest in a node
 * environment doesn't have it. Treating the bridge as optional
 * during store construction means the module is safely importable
 * from a test that just wants the store contract; the subscription
 * itself isn't exercised in tests.
 */
const subscribeToChanges = (cb: () => void): (() => void) | null => {
  if (typeof window === 'undefined') return null;
  const bridge = window.musaic;
  if (!bridge) return null;
  return bridge.library.onChanged(cb);
};

export const useLibraryStore = create<LibraryState>((set, get) => {
  const refresh = async (): Promise<void> => {
    try {
      const tracks = await listLibrary();
      set({ tracks, loading: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      console.error('library-store: refresh failed', err);
      set({ loading: false, error: message });
    }
  };

  // Attach the long-lived change subscription. Each library:changed
  // signal triggers a re-fetch; the new list replaces the old.
  // Errors during the in-flight refresh are caught inside `refresh`.
  subscribeToChanges(() => {
    void get().actions.refresh();
  });

  // Kick off the initial fetch. Fire-and-forget — the loading flag
  // flips once it resolves; UI components subscribed to the store
  // will re-render then.
  void refresh();

  return {
    tracks: [],
    loading: true,
    error: null,
    actions: { refresh },
  };
});
