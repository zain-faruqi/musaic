/**
 * YouTube IFrame Player API loader.
 *
 * The IFrame API is a single `<script src="https://www.youtube.com/iframe_api">`
 * that installs `window.YT` and then calls a globally-scoped
 * `window.onYouTubeIframeAPIReady` callback when ready. Both globals are
 * shared across the page — there can only be one loader, and a second
 * adapter must await the same readiness promise as the first.
 *
 * Singleton-as-a-module-level-promise pattern: the first call injects
 * the `<script>` and registers the global callback; subsequent calls
 * return the same in-flight (or resolved) promise. The IFrame API
 * itself is only loaded once per page, deliberately lazy so users
 * without YouTube connected don't pay the cost.
 *
 * **Test gap (documented inline):** this module
 * touches `document`, `window.YT`, and a script-tag side effect. It's
 * not unit-tested under Vitest's node environment — the loader's
 * surface (script injection + global callback) is intrinsically tied
 * to a real DOM and an out-of-band JSONP-style script. Same shape as
 * the existing chokidar / Electron-protocol-boundary gaps. The
 * adapter that uses it gets the unit-test
 * coverage via a mocked `window.YT`; this file is exercised at runtime
 * only.
 */

/**
 * Minimal subtype of the IFrame Player API's `YT.Player` we use. Kept
 * local to this adapter so a global type pollution from `@types/youtube`
 * isn't required. See youtube-adapter.ts for the full call sites.
 */
export type YTPlayer = {
  cueVideoById(videoId: string): void;
  loadVideoById(videoId: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volumePercent: number): void; // 0..100
  getVolume(): number; // 0..100
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number; // seconds
  getDuration(): number; // seconds
  getPlayerState(): number;
  /**
   * Returns the iframe element the IFrame Player API mounted into.
   * Documented on the public API surface; we use it for diagnostic
   * logging during the priming step (the iframe's geometry at prime
   * time tells us whether the YT API's 200×200 PLAYING prerequisite
   * is being satisfied).
   */
  getIframe(): HTMLIFrameElement;
  destroy(): void;
};

/**
 * The subset of the `YT.Player` constructor we use. Matches Google's
 * documented signature.
 */
export type YTPlayerConstructor = new (
  hostElement: HTMLElement | string,
  config: {
    width?: string | number;
    height?: string | number;
    videoId?: string;
    // The host the player's iframe loads from. Defaults to
    // https://www.youtube.com. We pass https://www.youtube-nocookie.com
    // to work around YouTube Error 153 ("Video player configuration
    // error") under file:// — see the adapter's site of use, plus
    // the referrer-meta in src/index.html.
    host?: string;
    playerVars?: Record<string, string | number>;
    events?: {
      onReady?: (event: { target: YTPlayer }) => void;
      onStateChange?: (event: { data: number; target: YTPlayer }) => void;
      onError?: (event: { data: number; target: YTPlayer }) => void;
    };
  },
) => YTPlayer;

/**
 * Shape of `window.YT` we depend on. Other members of the IFrame API
 * exist but the adapter only uses `Player` (the constructor) and the
 * `PlayerState` numeric constants.
 */
export type YTGlobal = {
  readonly Player: YTPlayerConstructor;
  readonly PlayerState: {
    readonly UNSTARTED: -1;
    readonly ENDED: 0;
    readonly PLAYING: 1;
    readonly PAUSED: 2;
    readonly BUFFERING: 3;
    readonly CUED: 5;
  };
};

declare global {
  interface Window {
    /** Installed by the IFrame API after the script loads. */
    YT?: YTGlobal;
    /**
     * Globally-scoped readiness callback. The IFrame API invokes this
     * once `window.YT` is fully initialized. Multiple-listener support
     * is up to us — the API only calls one function.
     */
    onYouTubeIframeAPIReady?: () => void;
  }
}

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

/**
 * The shared loader promise. Module-level so a second adapter
 * instantiation finds the same in-flight load.
 */
let loaderPromise: Promise<YTGlobal> | null = null;

/**
 * Load and resolve `window.YT`. Idempotent: repeated calls return the
 * same promise. Safe to call after readiness — resolves immediately
 * with the cached global.
 */
export const loadYouTubeIframeApi = (): Promise<YTGlobal> => {
  if (loaderPromise !== null) return loaderPromise;

  loaderPromise = new Promise<YTGlobal>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new Error('youtube: iframe API loader requires a DOM'));
      return;
    }

    // Already loaded (e.g. by some other adapter instance after a hot
    // reload, or because a previous load resolved before this getter
    // was called). The script side effect is a no-op the second time;
    // we just resolve.
    if (window.YT && typeof window.YT.Player === 'function') {
      resolve(window.YT);
      return;
    }

    // If someone else already registered the ready callback (defensive —
    // shouldn't happen in this codebase but the global is page-wide and
    // someone could in theory beat us to it), wrap their handler so
    // both run.
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = (): void => {
      try {
        prior?.();
      } catch (err) {
        console.warn('youtube: prior onYouTubeIframeAPIReady threw', err);
      }
      const yt = window.YT;
      if (yt && typeof yt.Player === 'function') {
        resolve(yt);
      } else {
        reject(new Error('youtube: iframe API ready callback fired without window.YT'));
      }
    };

    // If a `<script src="…/iframe_api">` is already on the page (e.g.
    // hot-reload of the renderer left it behind), don't inject a second.
    // The original script's `onYouTubeIframeAPIReady` callback already
    // ran or will run; either way our overwritten handler will fire on
    // the next ready signal, or the early-return above caught it.
    const existing = document.querySelector(
      `script[src="${IFRAME_API_SRC}"]`,
    );
    if (existing !== null) {
      // Defensive: if the script is present but YT didn't initialize
      // (load failed silently, ad-blocker, offline), we'd hang here
      // forever. The adapter's load() applies a separate timeout —
      // not enforced inside the loader itself, to keep this module's
      // surface minimal.
      return;
    }

    const tag = document.createElement('script');
    tag.src = IFRAME_API_SRC;
    tag.async = true;
    tag.onerror = (): void => {
      reject(new Error('youtube: iframe API script failed to load'));
    };
    document.head.appendChild(tag);
  });

  // If the load rejects, clear the cached promise so a future call
  // gets a fresh shot rather than perpetually returning the failure.
  loaderPromise.catch(() => {
    loaderPromise = null;
  });

  return loaderPromise;
};

/**
 * Test-only: reset the cached loader promise. Not exported through any
 * production path; used by tests that mock `window.YT` and need to
 * start clean across cases.
 */
export const __resetLoaderForTests = (): void => {
  loaderPromise = null;
};
