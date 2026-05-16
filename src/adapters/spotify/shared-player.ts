/**
 * Module-level singleton `Spotify.Player`.
 *
 * Why a singleton: the Web Playback SDK assumes one `Spotify.Player`
 * per page session. Spike-flagged risk; packaged-smoke confirmed.
 *
 * Symptom under the per-instance model:
 *   - First click works: SDK loads, Player#1 constructs, connects,
 *     fires `ready` with device_id D1, PUT play succeeds, audio
 *     plays.
 *   - Second click fails: adapter A unloads → Player#1.disconnect()
 *     → adapter B constructs Player#2 → connects → fires `ready`
 *     with D2 → PUT /me/player/play?device_id=D2 → HTTP 404 "Device
 *     not found". The new device_id is captured from `ready` but
 *     Spotify's edge doesn't know about it; the SDK's internal state
 *     after multiple connect/disconnect cycles is broken.
 *
 * The SDK's model is: **one device per page**, and PUT play with
 * different URIs swaps tracks on that one device. This singleton
 * captures that model directly. Each `SpotifyAdapter` instance is a
 * facade that:
 *   - Subscribes to event dispatch from the singleton.
 *   - Issues PUT play for its track when `play()` is called.
 *   - Cleans up its subscriptions on `unload()` (does not touch the
 *     singleton).
 *
 * Trade-off: load() can't pre-warm Spotify tracks (no spare device
 * to load into). PUT play happens at `play()` time instead.
 * Spotify-to-Spotify handoff costs one Web API round-trip at switch
 * (~200–500ms). The < 1.5s cross-source target covers this;
 * same-source target of < 200ms may be tight for Spotify-to-Spotify
 * and is acceptable for v1.
 */
import type {
  SpotifyGlobal,
  SpotifyPlayer,
  SpotifyPlayerState,
  SpotifyDeviceEvent,
  SpotifyErrorEvent,
} from './types';

/**
 * Generous timeout for the SDK's initial `ready` event. First-time
 * connection on a cold start includes SDK init, encrypted media
 * session setup, Spotify edge handshake, and device registration —
 * several seconds is normal.
 */
const READY_TIMEOUT_MS = 10_000;

/**
 * Subscriber registries — one Set per event type. The singleton
 * installs exactly one SDK listener per event at construction time;
 * that listener fans out to whichever adapter instances have
 * subscribed. This avoids the SDK's awkward `removeListener(event)`
 * semantics (which removes ALL listeners for an event, not just a
 * specific one) — subscriber management is pure JS Set operations.
 */
export type SharedPlayerSubscribers = {
  readonly state: Set<(s: SpotifyPlayerState | null) => void>;
  readonly authError: Set<(e: SpotifyErrorEvent) => void>;
  readonly accountError: Set<(e: SpotifyErrorEvent) => void>;
  readonly initError: Set<(e: SpotifyErrorEvent) => void>;
  readonly playbackError: Set<(e: SpotifyErrorEvent) => void>;
  readonly notReady: Set<(e: SpotifyDeviceEvent) => void>;
};

export type SharedSpotifyPlayer = {
  readonly player: SpotifyPlayer;
  readonly deviceId: string;
  readonly subscribers: SharedPlayerSubscribers;
  /**
   * Most recent `player_state_changed` from the SDK, regardless of
   * URI. Mutable container (`.current` is read/written; the
   * container itself is stable for closure capture). Adapters read
   * this to answer "is my track the currently-playing one on the
   * device?" — distinct from each adapter's own `#lastState` which
   * filters to its URI and would always report itself as current.
   */
  readonly latestState: { current: SpotifyPlayerState | null };
};

export type SharedPlayerOptions = {
  /** SDK loader seam — production uses sdk-loader.ts, tests inject. */
  readonly loadSdk: () => Promise<SpotifyGlobal>;
  /** Token bridge — production uses the preload, tests inject. */
  readonly getAccessToken: () => Promise<string | null>;
};

/**
 * The shared promise. Module-level so the first adapter's load
 * resolves it and every subsequent adapter awaits the same one.
 * Rejection clears the slot so a future call retries.
 */
let sharedPromise: Promise<SharedSpotifyPlayer> | null = null;

/**
 * Get the singleton, constructing it on first call. Subsequent
 * calls return the same promise (already-resolved on warm path).
 *
 * On rejection, the cached promise is cleared so the next call
 * tries again from scratch.
 */
export function getOrCreateSharedPlayer(
  options: SharedPlayerOptions,
): Promise<SharedSpotifyPlayer> {
  if (sharedPromise !== null) return sharedPromise;

  sharedPromise = (async (): Promise<SharedSpotifyPlayer> => {
    const sdk = await options.loadSdk();

    const subscribers: SharedPlayerSubscribers = {
      state: new Set(),
      authError: new Set(),
      accountError: new Set(),
      initError: new Set(),
      playbackError: new Set(),
      notReady: new Set(),
    };

    const latestState: { current: SpotifyPlayerState | null } = {
      current: null,
    };

    const player = new sdk.Player({
      name: 'Musaic',
      getOAuthToken: (cb) => {
        // SDK invokes this callback when it needs a token (initial
        // connect, refresh-after-expiry). We delegate to main via
        // the preload bridge. If no token is available, cb('')
        // causes the SDK to fire `authentication_error`, which is
        // categorized through the normal error path.
        void options.getAccessToken().then((token) => cb(token ?? ''));
      },
      // Singleton volume = 1.0; the PlayerManager invariant about
      // muted preloaded adapters doesn't apply to Spotify in this
      // model (there's no separate "preloaded" device). Each
      // adapter can still adjust this via setVolume, but in
      // practice only the "current" adapter is in scope.
      volume: 1,
    });

    // Install one SDK listener per event, fanning out to whatever
    // subscribers are currently registered. Subscribers are
    // adapters' per-instance handlers.
    player.addListener('player_state_changed', (state) => {
      // Cache the most recent state regardless of URI so adapter
      // facades can answer "am I current?". Each adapter's own
      // subscriber filters by URI; the unfiltered cache is what
      // tells them what the device is actually playing.
      latestState.current = state;
      for (const cb of subscribers.state) cb(state);
    });
    player.addListener('authentication_error', (e) => {
      for (const cb of subscribers.authError) cb(e);
    });
    player.addListener('account_error', (e) => {
      for (const cb of subscribers.accountError) cb(e);
    });
    player.addListener('initialization_error', (e) => {
      for (const cb of subscribers.initError) cb(e);
    });
    player.addListener('playback_error', (e) => {
      for (const cb of subscribers.playbackError) cb(e);
    });
    player.addListener('not_ready', (e) => {
      for (const cb of subscribers.notReady) cb(e);
    });

    const connected = await player.connect();
    if (!connected) {
      throw new Error('spotify: shared player connect() returned false');
    }

    const deviceId = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const onReady = ({ device_id }: { device_id: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(device_id);
      };
      player.addListener('ready', onReady);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `spotify: ready event timed out (${READY_TIMEOUT_MS}ms)`,
          ),
        );
      }, READY_TIMEOUT_MS);
    });

    // Bind to user gesture (locked decision: activateElement, no
    // muted-priming fallback in v1). Failure is non-fatal —
    // cross-source autoplay handoff may not engage but
    // click-initiated play has its own gesture.
    try {
      await player.activateElement();
    } catch (err) {
      console.warn(
        'spotify: activateElement failed; cross-source autoplay may not engage',
        err,
      );
    }

    return { player, deviceId, subscribers, latestState };
  })();

  sharedPromise.catch(() => {
    sharedPromise = null;
  });

  return sharedPromise;
}

/**
 * Reset the singleton. Used by tests for inter-test isolation, and
 * exposed for the Spotify-disconnect flow (the spotify-store can
 * call this when the user disconnects Spotify in Settings, so the
 * next connect rebuilds the device against fresh credentials).
 *
 * Does NOT call `disconnect()` on the existing player — that's
 * best-effort and we don't want it to block. The player object is
 * orphaned; eventual GC handles cleanup. Spotify's edge will
 * eventually time out the stale device.
 */
export function __resetSharedForTests(): void {
  sharedPromise = null;
}
