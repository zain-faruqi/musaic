import type { PlaybackAdapter, UnifiedTrack, Unsubscribe } from '@renderer/core/types';
import { POLL_INTERVAL_YOUTUBE_MS } from '@renderer/core/constants';
import { getVideoPanelContainer } from '@renderer/ui/layout/video-panel-registry';
import {
  loadYouTubeIframeApi,
  type YTGlobal,
  type YTPlayer,
} from './iframe-api-loader';

/**
 * IFrame Player API state values. Mirrored from `YT.PlayerState` rather
 * than imported because we care about a small subset and want to avoid
 * a hard dependency on the SDK module surface beyond what's already in
 * `iframe-api-loader.ts`.
 */
const YT_STATE_ENDED = 0;
const YT_STATE_PLAYING = 1;

/**
 * How long to wait for the priming `playVideo()` call to transition the
 * player into PLAYING state before giving up. Generous because video
 * load + network buffer can be slow on a fresh page; tight enough that
 * an unplayable video (region-blocked, embed-disabled, removed) gives
 * up well inside the 5s preload window.
 */
const PRIME_TIMEOUT_MS = 4_000;

/**
 * Default mount element id inside the video panel container. The
 * adapter creates a fresh `<div>` with this id on every `load()` and
 * destroys it on `unload()`; reusing the same id across adapter
 * instances is fine because at most one instance is live in the
 * container at a time (per-track instances.
 *
 * `<iframe>` reparenting concerns don't apply here: we destroy the
 * player (and its iframe) on unload rather than try to keep one alive
 * across tracks.
 */
const PLAYER_MOUNT_ID = 'musaic-youtube-player';

/**
 * Volume conversion. YouTube's `setVolume` takes 0..100; the contract is
 * 0..1. Conversion happens at the boundary, never at callsites —
 * same principle as position (sources that natively use seconds
 * convert at the adapter boundary, not at every callsite).
 */
const toYtVolume = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);

/**
 * Categorized YouTube playback failure. Subclass of Error so it still
 * flows through the adapter's `'error'` channel and PlayerManager's
 * generic error handling, but carries extra fields PlayerManager can
 * pull out to populate `state.playbackError`.
 *
 * The mapping from YT.PlayerError codes to reason:
 *   - 100         → 'not-found' (removed, private)
 *   - 101, 150    → 'embed-disallowed' (uploader disabled embedding)
 *   - 2, 5, other → 'unknown'
 *
 */
export class YouTubeUnplayableError extends Error {
  readonly reason: 'not-found' | 'embed-disallowed' | 'unknown';
  readonly watchUrl: string;
  readonly code: number;

  constructor(
    code: number,
    reason: 'not-found' | 'embed-disallowed' | 'unknown',
    watchUrl: string,
  ) {
    super(`youtube: player error (code ${code}, reason ${reason})`);
    this.name = 'YouTubeUnplayableError';
    this.reason = reason;
    this.watchUrl = watchUrl;
    this.code = code;
  }
}

/**
 * YT.PlayerError code → reason mapping. Exported for unit tests; the
 * adapter uses it internally to build YouTubeUnplayableError.
 */
export function youtubeErrorCodeToReason(
  code: number,
): 'not-found' | 'embed-disallowed' | 'unknown' {
  if (code === 100) return 'not-found';
  if (code === 101 || code === 150) return 'embed-disallowed';
  return 'unknown';
}

const watchUrlForVideoId = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

/**
 * YouTube playback adapter.
 *
 * Per-track instance lifetime: PlayerManager allocates a fresh adapter
 * per loaded track and disposes via `unload()`. The IFrame API's
 * `<iframe>` is created
 * fresh per load and torn down on unload; we don't try to reuse a
 * single player across tracks.
 *
 * State machine:
 *   - constructor: no IFrame API access yet; cheap.
 *   - load(track): awaits the singleton IFrame API loader, parses the
 *     videoId from `track.sourceId`, creates a new `YT.Player` mounted
 *     into the video panel container, cues the video (no autoplay,
 *     per the load/play split), starts the timeupdate poll, resolves
 *     when the player's `onReady` fires.
 *   - play(): playVideo()
 *   - pause(): pauseVideo()
 *   - seek(ms): seekTo(s, true)
 *   - setVolume(v): setVolume(v*100)
 *   - unload(): clear poll interval, destroy() the player, drop refs,
 *     remove the mount element from the DOM.
 *
 * Timeupdate polling: the IFrame API has no native timeupdate event.
 * 200ms interval (POLL_INTERVAL_YOUTUBE_MS) balances accuracy against
 * CPU. This is the "fallback when the SDK has no event" case — not a
 * workaround, the platform genuinely doesn't emit.
 */
export class YouTubeAdapter implements PlaybackAdapter {
  readonly source = 'youtube' as const;

  /**
   * Indirection seam for tests. Production goes to the real loader;
   * tests inject a fake that resolves with a mocked `YT` global.
   */
  readonly #loadIframeApi: () => Promise<YTGlobal>;
  /** Same — tests inject a fake container. */
  readonly #getContainer: () => HTMLElement | null;
  /**
   * Same — production uses `document.createElement('div')`. Tests
   * inject a fake element that satisfies the minimal surface used:
   * `id`, `isConnected`, `parentNode`. Routing through this seam
   * keeps the adapter unit-testable under Vitest's node environment
   * (no jsdom dependency).
   */
  readonly #createMountElement: () => HTMLElement;

  #player: YTPlayer | null = null;
  #mountEl: HTMLElement | null = null;
  /**
   * Latest position in ms, sampled from the poll. Stored so
   * `getPositionMs()` can return without calling the SDK (the
   * underlying iframe call is cheap but having a cached value means
   * the contract doesn't depend on player state being non-destroyed).
   */
  #positionMs = 0;
  #durationMs = 0;
  #pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly #timeupdateListeners = new Set<(ms: number) => void>();
  readonly #endedListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(err: Error) => void>();

  /**
   * One-shot handle the `onStateChange` callback uses to resolve the
   * priming step when state transitions to PLAYING. Cleared as soon
   * as it fires (or load() rejects via timeout / unload race).
   *
   * Lives on the instance rather than as a closure inside load()
   * because onStateChange is registered with the player at construction
   * and stays live for the player's lifetime — it needs to handle both
   * "priming, waiting for PLAYING" and "playing normally, watching for
   * ENDED" without conflating the two.
   */
  #primeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(options: {
    readonly loadIframeApi?: () => Promise<YTGlobal>;
    readonly getContainer?: () => HTMLElement | null;
    readonly createMountElement?: () => HTMLElement;
  } = {}) {
    this.#loadIframeApi = options.loadIframeApi ?? loadYouTubeIframeApi;
    this.#getContainer = options.getContainer ?? getVideoPanelContainer;
    this.#createMountElement =
      options.createMountElement ??
      ((): HTMLElement => {
        const el = document.createElement('div');
        el.id = PLAYER_MOUNT_ID;
        return el;
      });
  }

  async load(track: UnifiedTrack): Promise<void> {
    if (track.source !== 'youtube') {
      throw new Error(`youtube: cannot load track from source '${track.source}'`);
    }
    const videoId = track.sourceId;
    // The PlayerManager treats sourceId as opaque; an empty / malformed
    // value here means the caller built a bad UnifiedTrack. Reject
    // clearly rather than wait for the IFrame API to silently 404.
    if (typeof videoId !== 'string' || videoId.length === 0) {
      throw new Error(`youtube: track.sourceId is empty for track '${track.id}'`);
    }

    if (this.#player) {
      // Per-track instance contract: load() before unload() shouldn't
      // happen. If it does, clean up the prior player to keep things
      // sane rather than orphan the old iframe.
      this.#detach();
    }

    const container = this.#getContainer();
    if (!container) {
      throw new Error(
        'youtube: video panel container not registered — VideoPanel must be mounted before YouTube playback',
      );
    }

    // Create a fresh mount node inside the container. The IFrame API
    // replaces this node with its own `<iframe>`, so we don't try to
    // hold onto the original — `mountEl` is just for cleanup tracking.
    const mountEl = this.#createMountElement();
    container.appendChild(mountEl);
    this.#mountEl = mountEl;

    const yt = await this.#loadIframeApi();

    // The container could have unmounted while we were awaiting the
    // API loader — race conditions are the default in a player. If
    // `mountEl` is no longer attached,
    // assume teardown happened and bail.
    if (!mountEl.isConnected) {
      throw new Error('youtube: mount element detached during API load');
    }

    // Construct the player and wait for onReady. The promise resolves
    // synchronously when onReady fires — priming used to run against
    // `player` here, but priming has been dropped (see the comment
    // block further down). The promise is now awaited
    // purely for its `this.#player = event.target` side effect.
    await new Promise<YTPlayer>((resolve, reject) => {
      const onReady = (event: { target: YTPlayer }): void => {
        this.#player = event.target;

        // With `autoplay: 1` + `mute: 1` in playerVars (see below),
        // the iframe already auto-started the configured videoId
        // muted by the time onReady fires. We deliberately do NOT
        // call `cueVideoById` here — doing so would reset the player
        // to CUED state and cancel the auto-start, defeating the
        // whole point of the autoplay-on-load mechanism that
        // satisfies cross-origin iframe autoplay policy.
        //
        // An earlier version called cueVideoById here because
        // playerVars.autoplay was 0 and we needed an explicit cue.
        // The load/play split was: load() prepares (CUED), play()
        // starts playback. With autoplay=1 that collapses — load()
        // implicitly starts playback (muted), play() unmutes. Since
        // YouTube preload is skipped at the PlayerManager level,
        // load() is only called at handoff time when we want
        // playback to start, so the contract change is observationally
        // identical from PlayerManager's perspective.

        // Start the timeupdate poll. The API has no native timeupdate
        // event; we sample getCurrentTime() at the configured interval.
        this.#startPolling();

        // Sample duration immediately so the slot's duration is
        // populated by the time PlayerManager calls getDurationMs().
        // The IFrame API often returns 0 here (duration may not be
        // known until the player buffers); we keep re-sampling in the
        // poll and the duration is corrected mid-playback. Same
        // pattern as Chromium's mid-playback `<audio>.duration`
        // revisions — PlayerManager re-samples on each timeupdate.
        this.#durationMs = Math.round(event.target.getDuration() * 1000);

        resolve(event.target);
      };

      const onStateChange = (event: { data: number }): void => {
        // Priming path: the load() flow below sets #primeWaiter and
        // calls playVideo() muted; we resolve it when the player
        // confirms PLAYING. Cleared on the first hit so the handler
        // doesn't fire it again on later transitions.
        if (event.data === YT_STATE_PLAYING && this.#primeWaiter) {
          this.#primeWaiter.resolve();
          this.#primeWaiter = null;
        }
        // Normal path: dispatch ended to subscribers.
        if (event.data === YT_STATE_ENDED) {
          for (const cb of this.#endedListeners) cb();
        }
        // Other state values (-1 unstarted, 2 paused, 3 buffering,
        // 5 cued) are deliberately ignored — PlayerManager samples
        // position via timeupdate and doesn't need granular
        // state-change signals at this layer.
      };

      const onError = (event: { data: number }): void => {
        // YT error codes: 2 (invalid param), 5 (HTML5 player error),
        // 100 (not found), 101/150 (embedding disallowed).
        //
        // Categorize into a structured error type so PlayerManager
        // can populate state.playbackError and NowPlayingBar can show
        // the right affordance (open-on-youtube for embed-disallowed,
        // a plain "no longer available" message for not-found, generic
        // fallback for unknown).
        const reason = youtubeErrorCodeToReason(event.data);
        const err = new YouTubeUnplayableError(
          event.data,
          reason,
          watchUrlForVideoId(videoId),
        );
        // If we're mid-priming, also fail the prime so load() rejects
        // promptly instead of waiting for the timeout.
        if (this.#primeWaiter) {
          this.#primeWaiter.reject(err);
          this.#primeWaiter = null;
        }
        for (const cb of this.#errorListeners) cb(err);
      };

      try {
        new yt.Player(mountEl, {
          width: '100%',
          height: '100%',
          videoId,
          // Use the privacy-enhanced embed host
          // (youtube-nocookie.com) instead of the default
          // youtube.com. No third-party cookies are set until the
          // user actually interacts with the player. Functionally
          // identical to the default embed for our use case: same
          // player, same controls, same API surface. The renderer
          // CSP's frame-src already includes this host (slice-2
          // work — see src/index.html).
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            // autoplay=1 makes the YT IFrame Player API set
            // `allow="autoplay"` on the iframe element it creates,
            // which is what permits cross-origin autoplay under
            // Chromium's iframe-level Permissions Policy. Without
            // that attribute, playVideo() from a non-user-gesture
            // context (the auto-advance path) is silently rejected —
            // even with the renderer's own `autoplayPolicy:
            // 'no-user-gesture-required'` set, because the cross-
            // origin iframe runs its own policy check.
            //
            // mute=1 paired with autoplay=1: the iframe auto-starts
            // muted as soon as it loads. Muted autoplay is universally
            // permitted regardless of any policy, so this combination
            // is the most reliable path for the cold-start (no-prime,
            // no-preload) handoff into YouTube. adapter.play() then
            // calls unMute() to make the audio audible.
            //
            // Trade-off: load() is no longer "silent" in the sense
            // that the player begins playing (muted) as soon as the
            // iframe loads. Since YouTube preload is skipped (load()
            // is only called at handoff time, when we want the video
            // to play immediately anyway), there's no observable
            // difference vs the previous CUED-state contract. If
            // preload is re-enabled for YouTube later, this needs
            // revisiting.
            autoplay: 1,
            mute: 1,
            // Hide the related-videos shelf and the YouTube logo.
            // `rel=0` keeps end-of-video suggestions inside the
            // current channel only (full disable was removed by YT).
            rel: 0,
            modestbranding: 1,
            // playsinline=1 lets mobile UAs render the video in-page
            // rather than full-screen take-over. Cheap forward-compat.
            playsinline: 1,
            // Pin the origin sent in the postMessage handshake. The
            // IFrame API defaults to window.location.origin so this is
            // documentation more than behavior change — but making it
            // explicit guarantees the value the iframe sees, removes
            // one moving piece if YouTube ever changes the default,
            // and gives us a single grep target if origin handling
            // ever needs revisiting. The renderer's origin is
            // `http://localhost:<port>` in both dev (vite) and packaged
            // (embedded HTTP server bound to 127.0.0.1 but addressed
            // via `localhost`); the packaged build uses `localhost`
            // (with the bind on 127.0.0.1 but the URL string saying
            // `localhost`)
            // as the host string rather than the IP literal.
            //
            // `typeof window` guard because the adapter source compiles
            // under TS's DOM lib but the unit tests run in a Node
            // environment where `window` is undefined; the value isn't
            // actually used at test time (the FakeYTPlayer accepts any
            // config) but evaluating `window.location.origin` at object-
            // literal construction would still throw ReferenceError.
            origin: typeof window !== 'undefined' ? window.location.origin : '',
          },
          events: {
            onReady,
            onStateChange,
            onError,
          },
        });
      } catch (err) {
        reject(this.#wrapError('new YT.Player', err));
      }
    });

    // === Priming intentionally skipped ===
    //
    // Two earlier attempts at fixing the priming step (iframe-render-
    // context CSS first, in-grid container overflow second) didn't
    // resolve the cross-source-handoff bug. Priming is now skipped
    // entirely — load() leaves
    // the player in the CUED state that `loadVideoById` produces, and
    // play() at handoff just calls `playVideo()` against the un-primed
    // player.
    //
    // Trade-offs accepted:
    //
    // - Cold-start latency. Without priming during preload, the iframe
    //   has done no JS-level "play attempt" by the time handoff fires.
    //   First-frame-after-play is bounded by the iframe's own buffer/
    //   decode setup (~500–1500ms typical for a freshly cued video).
    //   Spec called this out as the cost of (b).
    //
    // - Autoplay policy risk. The muted-priming dance existed to
    //   satisfy Chromium's autoplay policy on non-gesture playVideo()
    //   calls. Without it, the auto-advance handoff path's playVideo()
    //   runs without (a) muted-play carve-out and (b) user activation.
    //   Whether it plays depends on Chromium's Media Engagement Index
    //   for youtube-nocookie.com on this profile and on the page's
    //   document-level user-activity heuristic. Empirically, profiles
    //   that have played YouTube before tend to permit; fresh profiles
    //   may show the click-to-play overlay.
    //
    // An earlier diagnostic console.warn at #prime entry is no longer
    // reachable (no caller), but #prime is kept in the file in case
    // priming's trade-offs turn out worse than the bug we're working
    // around and we re-enable it.
    //
    // void-statement so the unused fields/methods don't trip TS6133.
    void this.#prime;
  }

  /**
   * Run the muted-priming dance. Resolves when the player has been
   * observed in PLAYING state and is then paused. Rejects on timeout
   * (video unplayable or network failure) or on a player error event
   * routed through onError in load().
   *
   * Implementation: a single promise whose resolve/reject is held in
   * `#primeWaiter` and called from either the state-change path
   * (onStateChange → PLAYING) or a timeout setTimeout. Both paths
   * guard against double-settle so the second arrival is a no-op.
   * Using Promise.race over a separate timeout promise would leave
   * a dangling rejection in the loser's path.
   */
  async #prime(player: YTPlayer): Promise<void> {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // ---- Diagnostic: log the iframe's geometry at prime start ----
    //
    // The YT IFrame Player API silently refuses to enter PLAYING when
    // its iframe is smaller than 200×200 (documented behavior), and
    // Chromium throttles the rendering pipeline of cross-origin iframes
    // that have zero visible-area intersection with the viewport. If
    // priming fails, the iframe's rect here is the first piece
    // of evidence the next debugger should see — without it, "prime
    // timed out" is opaque. The log is one line per prime; cheap.
    // `console.warn` (not `console.log`) for the project's eslint
    // `no-console` rule — this is a debug breadcrumb, treat it as a
    // warning-level diagnostic.
    try {
      const iframe = player.getIframe();
      const rect = iframe.getBoundingClientRect();
      console.warn(
        `youtube: prime start — iframe ${rect.width}×${rect.height}` +
          ` at (${rect.left}, ${rect.top})`,
      );
    } catch (err) {
      console.warn(
        'youtube: prime start — getIframe/getBoundingClientRect threw',
        err,
      );
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.#primeWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          if (timeoutHandle !== null) clearTimeout(timeoutHandle);
          resolve();
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle !== null) clearTimeout(timeoutHandle);
          reject(err);
        },
      };
      timeoutHandle = setTimeout(() => {
        this.#primeWaiter?.reject(
          new Error(`youtube: prime timeout (${PRIME_TIMEOUT_MS}ms)`),
        );
      }, PRIME_TIMEOUT_MS);
    });

    try {
      player.mute();
      player.playVideo();
      await promise;
    } catch (err) {
      // Tear down whatever started: pause anything in flight, drop
      // the waiter, rethrow so load() rejects and PlayerManager's
      // opId machinery cleans up via safeUnload.
      try { player.pauseVideo(); } catch { /* ignore */ }
      try { player.unMute(); } catch { /* ignore */ }
      this.#primeWaiter = null;
      throw err instanceof Error ? err : new Error(String(err));
    }

    // Reached PLAYING. Pause and unmute — the player is now primed
    // and idle, ready for a non-gesture playVideo() to actually play.
    this.#primeWaiter = null;
    player.pauseVideo();
    player.unMute();
  }

  async play(): Promise<void> {
    if (!this.#player) throw new Error('youtube: play() called before load()');
    try {
      // unMute first — load() started the video playing muted (see
      // playerVars.autoplay=1 + mute=1 in the constructor block).
      // PlayerManager has already called adapter.setVolume() ahead of
      // play() via #loadAsCurrent / #promoteNext, so the underlying
      // player's volume value is already correct; unMute simply
      // removes the mute flag so that volume becomes audible.
      //
      // playVideo is defensive: if the auto-start has been paused
      // for any reason by the time we reach here (e.g. user pressed
      // pause and then play again), playVideo resumes; if the player
      // is already PLAYING, this is a no-op on the YT API side.
      this.#player.unMute();
      this.#player.playVideo();
    } catch (err) {
      throw this.#wrapError('playVideo', err);
    }
  }

  async pause(): Promise<void> {
    if (!this.#player) throw new Error('youtube: pause() called before load()');
    try {
      this.#player.pauseVideo();
    } catch (err) {
      throw this.#wrapError('pauseVideo', err);
    }
  }

  async seek(ms: number): Promise<void> {
    if (!this.#player) throw new Error('youtube: seek() called before load()');
    const clamped = Math.max(0, ms);
    try {
      // `allowSeekAhead: true` — let YT request the necessary bytes if
      // we've seeked past what's buffered. The alternative (`false`)
      // only seeks within the existing buffer; near-useless for the
      // scrubber's drag-anywhere case.
      this.#player.seekTo(clamped / 1000, true);
    } catch (err) {
      throw this.#wrapError('seekTo', err);
    }
    // Update the cached position immediately so the UI doesn't have
    // to wait a poll tick to reflect the new spot.
    this.#positionMs = clamped;
  }

  async setVolume(v: number): Promise<void> {
    if (!this.#player) throw new Error('youtube: setVolume() called before load()');
    try {
      this.#player.setVolume(toYtVolume(v));
    } catch (err) {
      throw this.#wrapError('setVolume', err);
    }
  }

  async unload(): Promise<void> {
    if (!this.#player && !this.#mountEl) return;
    this.#detach();
    this.#timeupdateListeners.clear();
    this.#endedListeners.clear();
    this.#errorListeners.clear();
    this.#positionMs = 0;
    this.#durationMs = 0;
  }

  getPositionMs(): number {
    return this.#positionMs;
  }

  getDurationMs(): number {
    return this.#durationMs;
  }

  getVisualElement(): HTMLElement | null {
    return this.#mountEl;
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
        throw new Error(`youtube: unknown event ${String(_exhaustive)}`);
      }
    }
  }

  // --- internals ----------------------------------------------------------

  #startPolling(): void {
    if (this.#pollHandle !== null) return;
    this.#pollHandle = setInterval(() => {
      if (!this.#player) return;
      let curSec: number;
      let durSec: number;
      try {
        curSec = this.#player.getCurrentTime();
        durSec = this.#player.getDuration();
      } catch {
        // If the player was torn down between the interval firing and
        // this callback executing, the SDK throws. The unload path
        // already cleared the interval; this is a harmless race.
        return;
      }
      const ms = Math.round(curSec * 1000);
      this.#positionMs = ms;
      // Re-sample duration each tick — YT sometimes reports 0 before
      // playback starts and a real value after. Same pattern as
      // Chromium revising `<audio>.duration` mid-playback (see
      // PlayerManager comment); both are absorbed identically by the
      // PlayerManager's per-timeupdate getDurationMs() check.
      const durMs = Math.round(durSec * 1000);
      if (durMs > 0) this.#durationMs = durMs;

      for (const cb of this.#timeupdateListeners) cb(ms);
    }, POLL_INTERVAL_YOUTUBE_MS);
  }

  #stopPolling(): void {
    if (this.#pollHandle === null) return;
    clearInterval(this.#pollHandle);
    this.#pollHandle = null;
  }

  /**
   * Tear down the player + mount node. Idempotent across the two-step
   * `#player === null && #mountEl !== null` case (load() failed
   * mid-flight, before the player constructor returned).
   */
  #detach(): void {
    this.#stopPolling();
    // If load() is still mid-priming when something tears the adapter
    // down (PlayerManager preload cancellation, e.g. user skipped),
    // reject the in-flight prime so load() returns promptly and
    // PlayerManager's opId check sees a rejection instead of waiting
    // for the 4s timeout.
    if (this.#primeWaiter) {
      this.#primeWaiter.reject(new Error('youtube: detached during prime'));
      this.#primeWaiter = null;
    }
    if (this.#player) {
      try {
        this.#player.destroy();
      } catch (err) {
        // The SDK occasionally throws on destroy when the iframe was
        // already removed by some other path; swallow rather than
        // propagate, but log so we can spot patterns.
        console.warn('youtube: destroy() threw', err);
      }
      this.#player = null;
    }
    if (this.#mountEl) {
      const el = this.#mountEl;
      this.#mountEl = null;
      // The element may have been removed already (panel unmount, or
      // YT internally swapping the div for an iframe and then dropping
      // it). Be lenient.
      try {
        el.parentNode?.removeChild(el);
      } catch (err) {
        console.warn('youtube: mount removal threw', err);
      }
    }
  }

  #wrapError(call: string, err: unknown): Error {
    const detail = err instanceof Error ? err.message : String(err);
    return new Error(`youtube: ${call} failed: ${detail}`);
  }
}
