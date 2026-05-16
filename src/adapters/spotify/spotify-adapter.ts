import type {
  PlaybackAdapter,
  UnifiedTrack,
  Unsubscribe,
} from '@renderer/core/types';
import { POLL_INTERVAL_SPOTIFY_MS } from '@renderer/core/constants';
import { spotifyTrackWebUrl } from '@renderer/core/spotify-uri';
import {
  getOrCreateSharedPlayer,
  type SharedPlayerOptions,
  type SharedSpotifyPlayer,
} from './shared-player';
import { loadSpotifyWebPlaybackSdk } from './sdk-loader';
import type { SpotifyGlobal, SpotifyPlayerState } from './types';

const PLAY_ENDPOINT = 'https://api.spotify.com/v1/me/player/play';

/**
 * Max wait for `player_state_changed` to confirm the URI loaded
 * after `PUT /me/player/play`. The SDK fires state-changed events
 * many times during load (buffer, prepare, etc.); we wait for one
 * that reflects the URI we just asked for, with `loading: false`.
 */
const URI_LOAD_TIMEOUT_MS = 8_000;

/**
 * Categorized Spotify playback failure. Field is named `watchUrl`
 * (not `openUrl`) for parity with PlaybackError.watchUrl — the
 * source-agnostic field on PlayerState that PlayerManager
 * duck-types on.
 */
export type SpotifyUnplayableReason =
  | 'region-locked'
  | 'premium-required'
  | 'content-removed'
  | 'auth-required'
  | 'unknown';

export class SpotifyUnplayableError extends Error {
  readonly reason: SpotifyUnplayableReason;
  readonly watchUrl: string;
  readonly originalMessage: string;

  constructor(
    reason: SpotifyUnplayableReason,
    watchUrl: string,
    originalMessage: string,
  ) {
    super(`spotify: player error (reason ${reason}) — ${originalMessage}`);
    this.name = 'SpotifyUnplayableError';
    this.reason = reason;
    this.watchUrl = watchUrl;
    this.originalMessage = originalMessage;
  }
}

/**
 * Classify a `playback_error` event message into a
 * SpotifyUnplayableReason. Order matters: a message containing both
 * "premium" and "region" should bias toward the more specific
 * affordance ("Spotify Premium required" → user upgrades).
 */
export function classifyPlaybackErrorMessage(
  message: string,
): SpotifyUnplayableReason {
  if (/premium/i.test(message)) return 'premium-required';
  if (/region/i.test(message)) return 'region-locked';
  if (/removed|unavailable|no longer/i.test(message)) return 'content-removed';
  return 'unknown';
}

type SpotifyAdapterOptions = {
  /** SDK loader seam — production uses sdk-loader.ts. */
  readonly loadSdk?: () => Promise<SpotifyGlobal>;
  /** Token bridge — production uses window.musaic.spotify.getToken. */
  readonly getAccessToken?: () => Promise<string | null>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly setIntervalImpl?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  readonly clearIntervalImpl?: (h: ReturnType<typeof setInterval>) => void;
};

const defaultGetAccessToken = async (): Promise<string | null> => {
  if (typeof window === 'undefined' || !window.musaic) return null;
  const result = await window.musaic.spotify.getToken();
  return result.kind === 'connected' ? result.accessToken : null;
};

/**
 * Spotify Web Playback SDK adapter.
 *
 * **Architectural shape** (different from LocalAdapter /
 * YouTubeAdapter): a facade over a module-level singleton
 * `Spotify.Player`. The SDK doesn't cleanly support multiple
 * `Spotify.Player` instances per renderer process — confirmed by
 * packaged-build smoke (PUT play returning "Device not found" on
 * the second adapter instance). See `shared-player.ts`'s header
 * comment for the full background.
 *
 * **Lifecycle per adapter instance:**
 * - `load(track)` — resolve the singleton (instant on warm path);
 *   wire this instance's subscribers onto the singleton's event
 *   dispatch; record the loaded track. Does NOT issue PUT play.
 * - `play()` — issue PUT /me/player/play with this track's URI;
 *   wait for state confirmation; start the timeupdate poll loop.
 *   Resume-vs-replay distinction: if our URI is already current and
 *   just paused, `resume()` skips the API hop.
 * - `pause()` / `seek()` / `setVolume()` — delegate to the
 *   singleton.
 * - `unload()` — remove this instance's subscribers; stop the poll
 *   loop. Does NOT disconnect the singleton player. Eventual GC
 *   and Spotify's edge timeout handle cleanup of orphaned state.
 *
 * **Why load doesn't issue PUT play:** with a singleton player,
 * there's one device and one URI loaded at a time. Issuing PUT
 * play during the preload window would interrupt the currently-
 * playing track. Spotify-to-Spotify "preload" is therefore a
 * no-op — the actual SDK call happens at `play()`, costing one
 * Web API round-trip (~200–500ms) at switch time. The <1.5s
 * cross-source target covers it.
 */
export class SpotifyAdapter implements PlaybackAdapter {
  readonly source = 'spotify' as const;

  readonly #loadSdk: () => Promise<SpotifyGlobal>;
  readonly #getAccessToken: () => Promise<string | null>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #setInterval: NonNullable<SpotifyAdapterOptions['setIntervalImpl']>;
  readonly #clearInterval: NonNullable<SpotifyAdapterOptions['clearIntervalImpl']>;

  #shared: SharedSpotifyPlayer | null = null;
  #loadedTrack: UnifiedTrack | null = null;
  /**
   * Cleanups for subscribers wired onto the shared player during
   * load(). Each removes one subscriber. Called in order on
   * unload(); cleared afterward.
   */
  #cleanups: Array<() => void> = [];
  /**
   * Last state snapshot that matched our loaded track's URI.
   * Position interpolation reads from here.
   */
  #lastState: SpotifyPlayerState | null = null;
  #lastStateTime = 0;
  #pollHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Has `ended` already fired for the loaded track? The SDK can
   * emit "paused at duration" multiple times (e.g. on seek-to-end);
   * we fire ended exactly once per load.
   */
  #endedFired = false;

  readonly #timeupdateListeners = new Set<(ms: number) => void>();
  readonly #endedListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(err: Error) => void>();

  constructor(options: SpotifyAdapterOptions = {}) {
    this.#loadSdk = options.loadSdk ?? loadSpotifyWebPlaybackSdk;
    this.#getAccessToken = options.getAccessToken ?? defaultGetAccessToken;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#setInterval =
      options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearInterval =
      options.clearIntervalImpl ??
      ((h) => {
        clearInterval(h);
      });
  }

  /**
   * Resolve the singleton and wire this instance's subscribers.
   * Does NOT issue PUT /me/player/play — that's `play()`'s job.
   */
  async load(track: UnifiedTrack): Promise<void> {
    if (track.source !== 'spotify') {
      throw new Error(
        `spotify: cannot load track from source '${track.source}'`,
      );
    }
    if (this.#shared) {
      // Tolerance for repeated load() — clean prior wiring first.
      this.#detach();
    }

    const sharedOptions: SharedPlayerOptions = {
      loadSdk: this.#loadSdk,
      getAccessToken: this.#getAccessToken,
    };
    const shared = await getOrCreateSharedPlayer(sharedOptions);

    this.#shared = shared;
    this.#loadedTrack = track;
    this.#endedFired = false;
    this.#lastState = null;

    const watchUrl = this.#watchUrl(track);

    // ---- Subscribe to events on the shared singleton ----
    //
    // State events filter by URI — the singleton receives one
    // state stream for whatever the device is doing, and each
    // adapter ignores states that aren't about its track.
    //
    // Error events are device-scoped (the SDK reports them against
    // the currently-playing track). We only forward to OUR error
    // listeners if our track is the current one, so an error on
    // adapter A doesn't fire on adapter B.

    const onState = (state: SpotifyPlayerState | null): void => {
      if (state === null) return;
      const ourUri = this.#loadedTrack?.sourceId;
      if (!ourUri) return;

      const isStillOurTrack =
        state.track_window.current_track.uri === ourUri;

      // ---- Diagnostic: log every state-event arrival ----
      //
      // The natural-end detection failed in packaged build through
      // two earlier detection passes, and the gap between "what the
      // unit tests model" and "what the real Web Playback SDK does in
      // packaged Electron" remains an active unknown. This log is
      // one line per state event, typically
      // <10 lines per track played. console.warn (not console.log)
      // because the project's eslint no-console rule only permits
      // warn/error. The `ourTrack` flag is the critical one — if the
      // SDK clears `track_window.current_track` on natural end, that's
      // what the multi-shape detector below has to catch.
      console.warn(
        `spotify: state event — paused=${state.paused}` +
          ` position=${state.position} duration=${state.duration}` +
          ` loading=${state.loading} ourTrack=${isStillOurTrack}`,
      );

      // Capture the *interpolated* position from the prior state
      // BEFORE we overwrite it (or before we early-return on URI
      // mismatch). The Spotify SDK does not emit a
      // `player_state_changed` on every position tick — there can be
      // minutes between state events during steady playback — so
      // `prior.position` alone is often stale at the moment a
      // natural-end state arrives. Interpolation gives us "where the
      // track would be right now if it had kept playing from the
      // prior state."
      const observedPriorPositionMs = (() => {
        if (this.#lastState === null) return 0;
        if (this.#lastState.paused) return this.#lastState.position;
        const elapsed = Date.now() - this.#lastStateTime;
        const interp = this.#lastState.position + elapsed;
        const dur = this.#lastState.duration;
        return dur > 0 && interp > dur ? dur : interp;
      })();
      const priorDurationMs = this.#lastState?.duration ?? 0;
      const priorWasPlaying =
        this.#lastState !== null && !this.#lastState.paused;

      // ---- Natural-end detection (multi-shape, post-iter-3 correction) ----
      //
      // The iter-2 detector required: `paused=true, position=0` AND
      // the state was still for our track AND duration > 0. The user's
      // post-iter-3 smoke test ("song completes and it says 0:00 on
      // current position with song paused, total duration displays
      // correctly") suggests the SDK is firing a state with position
      // reset but Spotify may also have cleared the track_window or
      // zeroed duration before the next state arrives. In either case
      // the iter-2 detector's early bails (URI mismatch, duration<=0)
      // would have masked the signal.
      //
      // This detector recognizes natural-end via ANY of three signal
      // shapes, as long as the prior state had us playing within the
      // near-end window:
      //
      //   (a) the new state is paused-at-zero for our track (textbook)
      //   (b) the new state's current_track is no longer our URI
      //       (Spotify cleared our slot)
      //   (c) the new state IS for our track but its duration is 0
      //       (Spotify unloaded the track's metadata)
      //
      // All three mean the same thing operationally — our track has
      // ended — and any of them is sufficient evidence given the
      // prior-near-end constraint.
      const NATURAL_END_WINDOW_MS = 3000;
      const priorLookedNearEnd =
        priorWasPlaying &&
        priorDurationMs > 0 &&
        priorDurationMs - observedPriorPositionMs <= NATURAL_END_WINDOW_MS;

      const looksLikeNaturalEnd =
        priorLookedNearEnd &&
        ((isStillOurTrack && state.paused && state.position === 0) ||
          !isStillOurTrack ||
          (isStillOurTrack && state.duration <= 0));

      if (!this.#endedFired && looksLikeNaturalEnd) {
        console.warn(
          'spotify: ended fired via event-based natural-end detector' +
            ` (isStillOurTrack=${isStillOurTrack},` +
            ` state.paused=${state.paused},` +
            ` state.position=${state.position},` +
            ` state.duration=${state.duration},` +
            ` observedPriorPositionMs=${observedPriorPositionMs},` +
            ` priorDurationMs=${priorDurationMs})`,
        );
        this.#endedFired = true;
        for (const cb of this.#endedListeners) cb();
        return;
      }

      // Past natural-end detection. If the new state isn't for our
      // track, ignore it from this point on — the seek-to-end and
      // poll-fallback paths only make sense for our own track's
      // states. Don't update lastState either (preserving the
      // "playing" lastState so the poll-based detector and any
      // future state events still see meaningful prior context).
      if (!isStillOurTrack) return;

      this.#lastState = state;
      this.#lastStateTime = Date.now();

      // Surface obviously-broken state shapes rather than swallow
      // them silently. Negative position has been seen in the wild
      // around connect races; if we ever see one we want a console
      // breadcrumb instead of an opaque "ended never fires" symptom.
      if (state.position < 0) {
        console.warn(
          `spotify: state has negative position ${state.position}`,
        );
        return;
      }

      // Once-only guard. Spotify can emit "paused at duration"
      // multiple times (e.g. on seek-to-end), and the natural-end
      // detector above would also fire on every subsequent
      // paused-at-0 state if the prior keeps satisfying the window
      // check. Preserve the existing guard semantics.
      if (this.#endedFired) return;
      if (state.loading) return;
      if (state.duration <= 0) return;

      // ---- Seek-to-end-then-pause detection (preserved) ----
      //
      // Distinct from the natural-end path: when the user drags the
      // scrubber to the very end while playing or paused, the SDK
      // emits `paused: true, position >= duration` (no auto-reset).
      // The LocalAdapter fires ended in this case too, so matching
      // its behavior keeps PlayerManager handoff uniform across
      // sources. The `#endedFired` once-only guard prevents
      // duplicate fires for subsequent identical states (e.g. the
      // SDK re-emits "paused at duration" once or twice as part of
      // its near-end housekeeping).
      if (state.paused && state.position >= state.duration) {
        console.warn('spotify: ended fired via seek-to-end detector');
        this.#endedFired = true;
        for (const cb of this.#endedListeners) cb();
      }
    };
    shared.subscribers.state.add(onState);
    this.#cleanups.push(() => {
      shared.subscribers.state.delete(onState);
    });

    const fireErrorIfOurs = (err: SpotifyUnplayableError): void => {
      const ourUri = this.#loadedTrack?.sourceId;
      // Read from the singleton's unfiltered latestState — our own
      // `#lastState` is filtered to our URI and would always claim
      // we're current. Without this, an error fired while a
      // different adapter's track is playing would still surface
      // on our error listeners.
      const currentUri =
        shared.latestState.current?.track_window.current_track.uri;
      if (ourUri && currentUri && ourUri !== currentUri) return;
      for (const cb of this.#errorListeners) cb(err);
    };

    const onAuthError = ({ message }: { message: string }): void => {
      fireErrorIfOurs(
        new SpotifyUnplayableError('auth-required', watchUrl, message),
      );
    };
    shared.subscribers.authError.add(onAuthError);
    this.#cleanups.push(() => {
      shared.subscribers.authError.delete(onAuthError);
    });

    const onAccountError = ({ message }: { message: string }): void => {
      fireErrorIfOurs(
        new SpotifyUnplayableError('premium-required', watchUrl, message),
      );
    };
    shared.subscribers.accountError.add(onAccountError);
    this.#cleanups.push(() => {
      shared.subscribers.accountError.delete(onAccountError);
    });

    const onInitError = ({ message }: { message: string }): void => {
      fireErrorIfOurs(
        new SpotifyUnplayableError('unknown', watchUrl, message),
      );
    };
    shared.subscribers.initError.add(onInitError);
    this.#cleanups.push(() => {
      shared.subscribers.initError.delete(onInitError);
    });

    const onPlaybackError = ({ message }: { message: string }): void => {
      const reason = classifyPlaybackErrorMessage(message);
      fireErrorIfOurs(new SpotifyUnplayableError(reason, watchUrl, message));
    };
    shared.subscribers.playbackError.add(onPlaybackError);
    this.#cleanups.push(() => {
      shared.subscribers.playbackError.delete(onPlaybackError);
    });

    const onNotReady = ({ device_id }: { device_id: string }): void => {
      console.warn(`spotify: device ${device_id} not_ready`);
    };
    shared.subscribers.notReady.add(onNotReady);
    this.#cleanups.push(() => {
      shared.subscribers.notReady.delete(onNotReady);
    });
  }

  async play(): Promise<void> {
    if (!this.#shared || !this.#loadedTrack) {
      throw new Error('spotify: play() called before load()');
    }
    const shared = this.#shared;
    const track = this.#loadedTrack;

    // Resume-vs-replay: same-URI-paused → resume() (no API hop).
    if (
      this.#lastState?.track_window.current_track.uri === track.sourceId &&
      this.#lastState?.paused
    ) {
      await shared.player.resume();
      this.#startPolling();
      return;
    }

    const accessToken = await this.#getAccessToken();
    if (accessToken === null) {
      throw new SpotifyUnplayableError(
        'auth-required',
        this.#watchUrl(track),
        'no access token available for PUT /me/player/play',
      );
    }
    await this.#startPlaybackOnDevice(track, accessToken, shared.deviceId);
    await this.#awaitUriLoaded(track.sourceId);
    this.#startPolling();
  }

  async pause(): Promise<void> {
    if (!this.#shared) throw new Error('spotify: pause() called before load()');
    await this.#shared.player.pause();
  }

  async seek(ms: number): Promise<void> {
    if (!this.#shared) throw new Error('spotify: seek() called before load()');
    const duration = this.getDurationMs() || this.#loadedTrack?.durationMs || 0;
    const clamped = Math.max(0, Math.min(ms, duration > 0 ? duration : ms));
    if (duration > 0 && (ms < -duration || ms > duration * 2)) {
      console.warn(
        `spotify: seek(${ms}) clamped to ${clamped}; track duration ${duration}`,
      );
    }
    await this.#shared.player.seek(clamped);
  }

  async setVolume(v: number): Promise<void> {
    if (!this.#shared) {
      throw new Error('spotify: setVolume() called before load()');
    }
    await this.#shared.player.setVolume(Math.max(0, Math.min(1, v)));
  }

  async unload(): Promise<void> {
    // Critical: if the singleton is currently playing OUR URI,
    // pause it before tearing down. Otherwise the SDK keeps playing
    // Spotify audio in the background while a new local/youtube
    // adapter starts — the "two adapters audible during handoff"
    // anti-pattern: two adapters audible during a handoff. The
    // pre-singleton model didn't hit this because per-instance
    // `disconnect()` killed playback as a side effect; pause is the
    // right replacement.
    //
    // Why URI-conditional: a Spotify-to-Spotify handoff can land
    // here AFTER the next adapter has already done its PUT play and
    // taken over the device. In that case the singleton's current
    // URI is the new adapter's, not ours, and we must not pause it.
    // The URI match guarantees we only pause when we're still the
    // device's foreground track. If we never saw a state event (a
    // rare load-then-immediate-unload race), `latestState.current`
    // is null and we skip — best-effort, and the next adapter's
    // PUT play will swap regardless.
    if (this.#shared && this.#loadedTrack) {
      const currentUri =
        this.#shared.latestState.current?.track_window.current_track.uri;
      const ourUri = this.#loadedTrack.sourceId;
      const stillPlayingOurs =
        currentUri === ourUri &&
        this.#shared.latestState.current?.paused === false;
      if (stillPlayingOurs) {
        try {
          await this.#shared.player.pause();
        } catch (err) {
          console.warn('spotify: pause during unload threw', err);
        }
      }
    }
    this.#detach();
    this.#timeupdateListeners.clear();
    this.#endedListeners.clear();
    this.#errorListeners.clear();
  }

  getPositionMs(): number {
    if (this.#lastState === null) return 0;
    if (this.#lastState.paused) return this.#lastState.position;
    const elapsed = Date.now() - this.#lastStateTime;
    const interpolated = this.#lastState.position + elapsed;
    const duration = this.#lastState.duration;
    if (duration > 0 && interpolated > duration) return duration;
    return interpolated;
  }

  getDurationMs(): number {
    return this.#lastState?.duration ?? 0;
  }

  getVisualElement(): HTMLElement | null {
    return null;
  }

  on(event: 'timeupdate', cb: (positionMs: number) => void): Unsubscribe;
  on(event: 'ended', cb: () => void): Unsubscribe;
  on(event: 'error', cb: (err: Error) => void): Unsubscribe;
  on(
    event: 'timeupdate' | 'ended' | 'error',
    cb: ((ms: number) => void) | (() => void) | ((err: Error) => void),
  ): Unsubscribe {
    switch (event) {
      case 'timeupdate': {
        const fn = cb as (ms: number) => void;
        this.#timeupdateListeners.add(fn);
        return () => {
          this.#timeupdateListeners.delete(fn);
        };
      }
      case 'ended': {
        const fn = cb as () => void;
        this.#endedListeners.add(fn);
        return () => {
          this.#endedListeners.delete(fn);
        };
      }
      case 'error': {
        const fn = cb as (err: Error) => void;
        this.#errorListeners.add(fn);
        return () => {
          this.#errorListeners.delete(fn);
        };
      }
      default: {
        const _exhaustive: never = event;
        throw new Error(`spotify: unknown event ${String(_exhaustive)}`);
      }
    }
  }

  // --- internals --------------------------------------------------------

  /**
   * Issue PUT /me/player/play for our URI on the shared device.
   * Maps HTTP errors to SpotifyUnplayableError variants. The 404
   * classifier checks the body so "Device not found" maps to
   * `auth-required` (correct user affordance: device registration
   * stale, user should re-engage) rather than `content-removed`
   * (which would lie about the cause). Anything else 404 is
   * genuinely content-removed.
   */
  async #startPlaybackOnDevice(
    track: UnifiedTrack,
    accessToken: string,
    deviceId: string,
  ): Promise<void> {
    const url = new URL(PLAY_ENDPOINT);
    url.searchParams.set('device_id', deviceId);

    const response = await this.#fetch(url.toString(), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [track.sourceId] }),
    });

    const watchUrl = this.#watchUrl(track);

    if (response.status === 204 || response.status === 202) return;

    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // ignore — fall through to status-only error below
    }

    if (response.status === 401) {
      throw new SpotifyUnplayableError(
        'auth-required',
        watchUrl,
        `PUT /me/player/play HTTP 401: ${bodyText || '(empty)'}`,
      );
    }
    if (response.status === 403) {
      const classified = classifyPlaybackErrorMessage(bodyText);
      const reason = classified === 'unknown' ? 'premium-required' : classified;
      throw new SpotifyUnplayableError(
        reason,
        watchUrl,
        `PUT /me/player/play HTTP 403: ${bodyText || '(empty)'}`,
      );
    }
    if (response.status === 404) {
      // Body-distinguished: "Device not found" is the SDK device
      // registration going stale; anything else is content-removed.
      // The singleton model should prevent "Device not found" in
      // normal operation, but we map it correctly when it slips.
      const reason: SpotifyUnplayableReason = /device not found/i.test(bodyText)
        ? 'auth-required'
        : 'content-removed';
      throw new SpotifyUnplayableError(
        reason,
        watchUrl,
        `PUT /me/player/play HTTP 404: ${bodyText || '(empty)'}`,
      );
    }

    throw new Error(
      `spotify: PUT /me/player/play HTTP ${response.status}: ${bodyText || '(empty)'}`,
    );
  }

  /**
   * Wait for a player_state_changed reflecting our URI with
   * `loading: false`. The state subscriber wired in load()
   * already populates `#lastState`; this method adds a one-shot
   * watcher for the wait.
   */
  async #awaitUriLoaded(uri: string): Promise<void> {
    if (!this.#shared) {
      throw new Error('spotify: #awaitUriLoaded without shared player');
    }
    // Fast path: state already arrived (rare race — state fired
    // between PUT and the await).
    if (
      this.#lastState?.track_window.current_track.uri === uri &&
      !this.#lastState.loading
    ) {
      return;
    }

    const shared = this.#shared;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const watcher = (state: SpotifyPlayerState | null): void => {
        if (settled || state === null) return;
        if (state.track_window.current_track.uri !== uri) return;
        if (state.loading) return;
        settled = true;
        clearTimeout(timeout);
        shared.subscribers.state.delete(watcher);
        resolve();
      };
      shared.subscribers.state.add(watcher);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        shared.subscribers.state.delete(watcher);
        reject(
          new Error(
            `spotify: URI load confirmation timed out (${URI_LOAD_TIMEOUT_MS}ms)`,
          ),
        );
      }, URI_LOAD_TIMEOUT_MS);
    });
  }

  #startPolling(): void {
    if (this.#pollHandle !== null) return;
    this.#pollHandle = this.#setInterval(() => {
      const ms = this.getPositionMs();
      for (const cb of this.#timeupdateListeners) cb(ms);

      // ---- Poll-based ended fallback ----
      //
      // Belt-and-braces for the natural-end detection above. The
      // event-based detector in onState relies on the SDK firing a
      // recognizable natural-end state (`paused: true, position: 0`
      // after the auto-reset). In packaged-build smoke we've
      // observed cases where that state either doesn't arrive in
      // a recognizable shape or doesn't arrive at all — the SDK
      // just stops emitting and the track silently ends.
      //
      // Events are the truth, polling is a fallback when the SDK
      // has no event — that's exactly the case here. The mock
      // adapter is timer-based for the same
      // reason. When our interpolated position has reached the
      // track's duration and the SDK still claims we're playing
      // (lastState.paused === false), treat the timer crossing as
      // the ended signal.
      if (this.#endedFired) return;
      const lastState = this.#lastState;
      if (lastState === null || lastState.paused) return;
      const duration = lastState.duration;
      if (duration <= 0) return;
      if (ms >= duration) {
        console.warn(
          `spotify: ended fired via poll-based fallback` +
            ` (interpolated ms=${ms}, duration=${duration})`,
        );
        this.#endedFired = true;
        for (const cb of this.#endedListeners) cb();
      }
    }, POLL_INTERVAL_SPOTIFY_MS);
  }

  #stopPolling(): void {
    if (this.#pollHandle === null) return;
    this.#clearInterval(this.#pollHandle);
    this.#pollHandle = null;
  }

  #detach(): void {
    this.#stopPolling();
    for (const cleanup of this.#cleanups) {
      try {
        cleanup();
      } catch (err) {
        console.warn('spotify: subscriber cleanup threw', err);
      }
    }
    this.#cleanups = [];
    this.#shared = null;
    this.#loadedTrack = null;
    this.#lastState = null;
    this.#endedFired = false;
  }

  /**
   * Build the open-on-spotify URL for the loaded track. Strips the
   * `spotify:track:` prefix from sourceId (which we know is the
   * URI form
   * canonical URI").
   */
  #watchUrl(track: UnifiedTrack): string {
    return spotifyTrackWebUrl(track.sourceId.replace(/^spotify:track:/, ''));
  }
}
