import { create } from 'zustand';
import { PlayerManager } from '@renderer/core/PlayerManager';
import { createAdapter } from '@renderer/core/create-adapter';
import type { PlayerState, UnifiedTrack } from '@renderer/core/types';

/**
 * Action surface exposed to UI. All actions are fire-and-forget from the
 * caller's point of view — state changes flow back through the
 * PlayerManager → store subscription, not through action return values.
 */
type PlayerActions = {
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  jumpTo: (cursor: number) => void;
  setVolume: (v: number) => void;
  setQueue: (
    tracks: readonly UnifiedTrack[],
    options?: { readonly cursor?: number; readonly autoplay?: boolean },
  ) => void;
  /**
   * Append a track to the queue without disturbing current playback.
   * If the current track is inside the preload window, the next
   * timeupdate will fire preload for the appended track. See
   * PlayerManager.enqueue for the full contract.
   */
  enqueue: (track: UnifiedTrack) => void;
  /**
   * Clear PlayerState.playbackError. Used by NowPlayingBar's "dismiss"
   * affordance for non-actionable failures (not-found, unknown). For
   * actionable failures (embed-disallowed) the user clicks
   * "open on youtube" instead and the error stays until track change.
   */
  dismissPlaybackError: () => void;
};

type PlayerStore = PlayerState & {
  /**
   * Action methods, namespaced to avoid collision with state fields
   * (notably `next`, which is both an upcoming track and a skip action).
   * This object's reference is stable across state updates.
   */
  readonly actions: PlayerActions;
};

/**
 * Wrap a fire-and-forget promise with a console.error handler. Keeps
 * unhandled rejections from leaking. PlayerManager catches its own
 * errors internally and surfaces them via `playbackState: 'error'`,
 * so this catch is defense-in-depth for things like "called after
 * dispose" (which throws synchronously and is a programmer error).
 */
const wrap = (p: Promise<unknown>): void => {
  void p.catch((err: unknown) => {
    console.error('player-store: action failed', err);
  });
};

/**
 * Singleton PlayerManager. Constructed once when this module is first
 * imported. Lives for the lifetime of the renderer.
 *
 * Not exported. The only way to drive it is through the store's
 * actions; the only way to read its state is through the store's
 * selectors. This keeps PlayerManager an implementation detail.
 */
const playerManager = new PlayerManager({
  createAdapter,
  initialVolume: 1,
});

export const usePlayerStore = create<PlayerStore>((set) => {
  // Sync state from the manager whenever it changes. This subscription
  // is permanent — there's no unsubscribe path because the manager and
  // store live equally long (the renderer process). On Electron app
  // quit, both are torn down together.
  playerManager.on('state', (state) => {
    // set() shallow-merges by default, so this preserves `actions`.
    set(state);
  });

  return {
    ...playerManager.getState(),
    actions: {
      play: () => wrap(playerManager.play()),
      pause: () => wrap(playerManager.pause()),
      togglePlayPause: () => wrap(playerManager.togglePlayPause()),
      next: () => wrap(playerManager.next()),
      previous: () => wrap(playerManager.previous()),
      seek: (ms) => wrap(playerManager.seek(ms)),
      jumpTo: (cursor) => wrap(playerManager.jumpTo(cursor)),
      setVolume: (v) => playerManager.setVolume(v),
      setQueue: (tracks, options) => wrap(playerManager.setQueue(tracks, options)),
      enqueue: (track) => playerManager.enqueue(track),
      dismissPlaybackError: () => playerManager.dismissError(),
    },
  };
});

/**
 * Direct access to the manager for code that lives outside React and
 * can't use the hook (e.g. the M3 Now Playing bridge in main, which
 * receives commands via IPC and dispatches to the renderer's manager).
 *
 * UI code should NOT use this — use `usePlayerStore` instead.
 */
export const getPlayerManager = (): PlayerManager => playerManager;
