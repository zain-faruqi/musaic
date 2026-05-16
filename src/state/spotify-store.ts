import { create } from 'zustand';
import {
  spotifyStatus as spotifyStatusSchema,
  type SpotifyStatus,
} from '@ipc/contracts';

/**
 * Renderer-side mirror of Spotify connection state.
 *
 * Same pattern as library-store: a single module-level subscription
 * (`spotify:status-changed`) drives re-fetches via the read-only
 * `status()` IPC. Initial fetch kicks off at module load so the
 * Connections row doesn't need its own useEffect.
 *
 * `connect()` is exposed as an action that flips local state to
 * 'connecting' optimistically, then awaits main's reply and updates
 * state. The IPC promise itself resolves with the final status
 * (connected | error), but main also fires `spotify:status-changed`
 * along the way, so the store would converge regardless — the
 * optimistic update is for the in-flight period between click and
 * resolve.
 *
 * Why no separate `src/state/spotify.ts` wrapper module: the library
 * pattern (library.ts + library-store.ts) splits because pickAndPlay
 * does post-import dispatch into the player store; nothing analogous
 * exists here yet. When 3a-iii's adapter brings that need, the split
 * happens then.
 */
type SpotifyState = {
  readonly status: SpotifyStatus;
  readonly actions: {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    refresh(): Promise<void>;
  };
};

/**
 * Test seam. Same shape as library-store's helper — at vitest time,
 * `window.musaic` doesn't exist; treating the bridge as optional
 * during store construction means the module is importable from any
 * test that just wants the store contract, without exercising the
 * subscription.
 */
const subscribeToStatusChanges = (cb: () => void): (() => void) | null => {
  if (typeof window === 'undefined') return null;
  const bridge = window.musaic;
  if (!bridge) return null;
  return bridge.spotify.onStatusChanged(cb);
};

/**
 * IPC wrapper: validate main's response via Zod before letting it
 * into the store. Defense-in-depth at the IPC boundary — every
 * response is unknown until parsed.
 */
const fetchStatus = async (): Promise<SpotifyStatus> => {
  if (typeof window === 'undefined' || !window.musaic) {
    return { kind: 'disconnected' };
  }
  const raw = await window.musaic.spotify.status();
  return spotifyStatusSchema.parse(raw);
};

const invokeConnect = async (): Promise<SpotifyStatus> => {
  if (typeof window === 'undefined' || !window.musaic) {
    return { kind: 'disconnected' };
  }
  const raw = await window.musaic.spotify.connect();
  return spotifyStatusSchema.parse(raw);
};

const invokeDisconnect = async (): Promise<void> => {
  if (typeof window === 'undefined' || !window.musaic) return;
  await window.musaic.spotify.disconnect();
};

export const useSpotifyStore = create<SpotifyState>((set, get) => {
  const refresh = async (): Promise<void> => {
    try {
      const status = await fetchStatus();
      set({ status });
    } catch (err) {
      // A parse error here is a programmer-visible bug, not a user-
      // visible state. Log and leave the store as-is — the previous
      // status remains visible. Mirrors how library-store handles
      // refresh failures.
      console.error('spotify-store: status fetch failed', err);
    }
  };

  const connect = async (): Promise<void> => {
    // Optimistic 'connecting' state for the in-flight period.
    set({ status: { kind: 'connecting' } });
    try {
      const status = await invokeConnect();
      set({ status });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      console.error('spotify-store: connect failed', err);
      set({ status: { kind: 'error', message } });
    }
  };

  const disconnect = async (): Promise<void> => {
    try {
      await invokeDisconnect();
      // Main fires `spotify:status-changed` from disconnect(); the
      // subscription below will re-fetch. We don't optimistically
      // set 'disconnected' here because the push channel will
      // converge regardless and a redundant local set would only
      // matter on the rare race where the push channel takes
      // longer than the IPC reply.
    } catch (err) {
      console.error('spotify-store: disconnect failed', err);
    }
  };

  // Long-lived push subscription. Each status-changed signal
  // triggers a re-fetch; the new status replaces the old.
  subscribeToStatusChanges(() => {
    void get().actions.refresh();
  });

  // Kick off the initial fetch. Fire-and-forget — the UI shows
  // 'disconnected' (the initial state) until it resolves. Subsequent
  // fetches happen on push.
  void refresh();

  return {
    status: { kind: 'disconnected' },
    actions: { connect, disconnect, refresh },
  };
});
