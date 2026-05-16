/**
 * Spotify Web Playback SDK loader.
 *
 * The Web Playback SDK is a single `<script src="https://sdk.scdn.co/spotify-player.js">`
 * that installs `window.Spotify.Player` (the constructor) and calls a
 * globally-scoped `window.onSpotifyWebPlaybackSDKReady` callback once
 * ready. Both globals are shared across the page — like the YouTube
 * IFrame API, the SDK can only be loaded once, and a second adapter
 * must await the same readiness promise as the first.
 *
 * Singleton-as-a-module-level-promise pattern: matches
 * src/adapters/youtube/iframe-api-loader.ts. The first call injects
 * the `<script>` and registers the global callback; subsequent calls
 * return the same in-flight (or resolved) promise.
 *
 * **Test gap (documented inline):** this module
 * touches `document`, `window.Spotify`, and a script-tag side effect.
 * Not unit-tested under Vitest's node environment — same intrinsic
 * tie to a real DOM that the YouTube IFrame loader has. The adapter
 * that uses it (`spotify-adapter.ts`) gets its coverage via mocked
 * SDK globals.
 */
import type { SpotifyGlobal } from './types';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';

let loaderPromise: Promise<SpotifyGlobal> | null = null;

/**
 * Load and resolve `window.Spotify`. Idempotent: repeated calls
 * return the same promise. Safe to call after readiness — resolves
 * immediately with the cached global.
 */
export const loadSpotifyWebPlaybackSdk = (): Promise<SpotifyGlobal> => {
  if (loaderPromise !== null) return loaderPromise;

  loaderPromise = new Promise<SpotifyGlobal>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new Error('spotify: SDK loader requires a DOM'));
      return;
    }

    // Already loaded — script ran in a previous load(), or another
    // adapter instance beat us to it. Resolve immediately.
    if (window.Spotify && typeof window.Spotify.Player === 'function') {
      resolve(window.Spotify);
      return;
    }

    // If someone else already registered the ready callback, wrap
    // their handler so both run. (Defensive — shouldn't happen in
    // this codebase but the global is page-wide.)
    const prior = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = (): void => {
      try {
        prior?.();
      } catch (err) {
        console.warn('spotify: prior onSpotifyWebPlaybackSDKReady threw', err);
      }
      const sp = window.Spotify;
      if (sp && typeof sp.Player === 'function') {
        resolve(sp);
      } else {
        reject(
          new Error(
            'spotify: SDK ready callback fired without window.Spotify',
          ),
        );
      }
    };

    // If a `<script src="…/spotify-player.js">` is already on the page
    // (hot reload, prior load() instance), don't inject a second. The
    // original script's ready callback already ran or will run; either
    // way our overwritten handler will fire on the next ready signal.
    const existing = document.querySelector(`script[src="${SDK_SRC}"]`);
    if (existing !== null) {
      return;
    }

    const tag = document.createElement('script');
    tag.src = SDK_SRC;
    tag.async = true;
    tag.onerror = (): void => {
      reject(new Error('spotify: SDK script failed to load'));
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
 * Test-only: reset the cached loader promise. Not used in production
 * paths; the adapter's unit tests mock the loader directly via the
 * adapter constructor's `loadSdk` seam rather than going through
 * this module.
 */
export const __resetLoaderForTests = (): void => {
  loaderPromise = null;
};
