import type {
  PlaybackAdapter,
  UnifiedTrack,
  Unsubscribe,
} from '@renderer/core/types';
import { POLL_INTERVAL_YOUTUBE_MS } from '@renderer/core/constants';

/**
 * Mock Spotify adapter used in development.
 *
 * Why this exists: the real
 * SpotifyAdapter loads the Web Playback SDK, which only accepts
 * production-VMP-signed clients. `npm run dev` runs the unsigned
 * dev-VMP castlabs build, against which Spotify's license server
 * returns HTTP 500. So the mock takes over in dev
 * so the UI, queue, scrubber, and handoff machinery can be
 * exercised against the full PlaybackAdapter contract without
 * needing a packaged + EVS-signed build for every iteration.
 *
 * What the mock simulates:
 *   - Position advances on a timer (200ms cadence, matching the
 *     YouTube poll interval — close enough to "real Spotify, which
 *     is sampled at 250ms" that handoff timing tests carry over).
 *   - Play / pause / seek / setVolume all move state correctly.
 *   - `ended` fires once when position reaches `durationMs`.
 *   - `getVisualElement()` returns null (Spotify has no DOM element;
 *     same as the real adapter).
 *
 * What the mock does NOT simulate:
 *   - Audio. There is intentionally no sound — picking an "audible"
 *     mock means either shipping a bundled clip (license complexity,
 *     bundle size) or synthesizing a tone (audible test pollution).
 *     The contract doesn't require audio; the scrubber and handoff
 *     are what we want exercised. End-to-end real-audio verification
 *     happens at packaged-smoke time.
 *   - Real Spotify failure modes — region-locked, premium-required,
 *     etc. The mock always succeeds. If a future test needs to
 *     simulate a specific failure, expose a constructor option;
 *     don't pollute the happy path.
 *
 * Lifecycle: per-track instance, same as every other adapter. The
 * timer is started on play(), stopped on pause()/unload(), and
 * cleared cleanly so multiple sequential loads don't leak.
 */

/**
 * Constructor options. `setIntervalImpl` / `clearIntervalImpl` are
 * test seams; production goes to the real globals.
 */
type MockSpotifyAdapterOptions = {
  readonly setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalImpl?: (h: ReturnType<typeof setInterval>) => void;
};

/** Mock playback advances position at this cadence. */
const ADVANCE_INTERVAL_MS = POLL_INTERVAL_YOUTUBE_MS;

export class MockSpotifyAdapter implements PlaybackAdapter {
  readonly source = 'spotify' as const;

  readonly #setInterval: NonNullable<MockSpotifyAdapterOptions['setIntervalImpl']>;
  readonly #clearInterval: NonNullable<MockSpotifyAdapterOptions['clearIntervalImpl']>;

  #loadedTrack: UnifiedTrack | null = null;
  #positionMs = 0;
  #durationMs = 0;
  #playing = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastTickTime = 0;

  readonly #timeupdateListeners = new Set<(ms: number) => void>();
  readonly #endedListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(err: Error) => void>();

  constructor(options: MockSpotifyAdapterOptions = {}) {
    this.#setInterval =
      options.setIntervalImpl ??
      ((fn, ms) => setInterval(fn, ms));
    this.#clearInterval =
      options.clearIntervalImpl ??
      ((h) => {
        clearInterval(h);
      });
  }

  async load(track: UnifiedTrack): Promise<void> {
    if (track.source !== 'spotify') {
      throw new Error(
        `spotify (mock): cannot load track from source '${track.source}'`,
      );
    }

    // Clean up any prior state — load before unload shouldn't happen
    // under per-track-instance discipline, but tolerate it the way
    // the LocalAdapter does (detach + continue).
    this.#stopTimer();
    this.#loadedTrack = track;
    this.#positionMs = 0;
    // The mock has no source-of-truth beyond metadata. Locked
    // decision (`getDurationMs()` adapter-reported is authoritative):
    // PlayerManager re-samples on each timeupdate. For the mock,
    // that re-sample is a no-op — the value never changes after
    // load — but the contract is preserved.
    this.#durationMs = track.durationMs;
    this.#playing = false;
  }

  async play(): Promise<void> {
    if (!this.#loadedTrack) {
      throw new Error('spotify (mock): play() called before load()');
    }
    if (this.#playing) return;
    this.#playing = true;
    this.#lastTickTime = Date.now();
    this.#startTimer();
  }

  async pause(): Promise<void> {
    if (!this.#loadedTrack) {
      throw new Error('spotify (mock): pause() called before load()');
    }
    this.#playing = false;
    this.#stopTimer();
  }

  async seek(ms: number): Promise<void> {
    if (!this.#loadedTrack) {
      throw new Error('spotify (mock): seek() called before load()');
    }
    // Two-tier clamp matching LocalAdapter (locked decision: seek()
    // clamping behavior). Silent clamp for slight overruns; warn
    // for gross out-of-range to surface caller bugs.
    const duration = this.#durationMs > 0 ? this.#durationMs : this.#loadedTrack.durationMs;
    const clamped = Math.max(0, Math.min(ms, duration));
    if (duration > 0 && (ms < -duration || ms > duration * 2)) {
      console.warn(
        `spotify (mock): seek(${ms}) clamped to ${clamped}; track duration ${duration}`,
      );
    }
    this.#positionMs = clamped;
    // Reset the tick anchor so the next timer fire computes deltas
    // from the new position rather than the old one.
    this.#lastTickTime = Date.now();
    // Notify subscribers so the scrubber updates immediately rather
    // than waiting for the next tick.
    for (const cb of this.#timeupdateListeners) cb(clamped);
  }

  async setVolume(_volume: number): Promise<void> {
    if (!this.#loadedTrack) {
      throw new Error('spotify (mock): setVolume() called before load()');
    }
    // Nothing audible to change; the value is intentionally
    // discarded. PlayerManager uses setVolume(0) on preload and
    // setVolume(userVolume) on handoff — both work as expected
    // because the mock plays silent either way.
    void _volume;
  }

  async unload(): Promise<void> {
    this.#stopTimer();
    this.#loadedTrack = null;
    this.#positionMs = 0;
    this.#durationMs = 0;
    this.#playing = false;
    this.#timeupdateListeners.clear();
    this.#endedListeners.clear();
    this.#errorListeners.clear();
  }

  getPositionMs(): number {
    return this.#positionMs;
  }

  getDurationMs(): number {
    return this.#durationMs;
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
        throw new Error(`spotify (mock): unknown event ${String(_exhaustive)}`);
      }
    }
  }

  // --- internals ----------------------------------------------------------

  #startTimer(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#setInterval(() => this.#tick(), ADVANCE_INTERVAL_MS);
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    this.#clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Advance position by the wall-clock elapsed since the previous
   * tick. Using elapsed-time rather than a fixed increment keeps the
   * simulation honest under load (slow event loop, paused tab) and
   * matches how a real audio engine reports position.
   */
  #tick(): void {
    if (!this.#loadedTrack || !this.#playing) return;
    const now = Date.now();
    const elapsed = now - this.#lastTickTime;
    this.#lastTickTime = now;
    let nextPos = this.#positionMs + elapsed;

    if (nextPos >= this.#durationMs && this.#durationMs > 0) {
      nextPos = this.#durationMs;
      this.#positionMs = nextPos;
      this.#playing = false;
      this.#stopTimer();
      // Notify subscribers in order: timeupdate first (so the
      // scrubber lands at the end), then ended once.
      for (const cb of this.#timeupdateListeners) cb(nextPos);
      for (const cb of this.#endedListeners) cb();
      return;
    }
    this.#positionMs = nextPos;
    for (const cb of this.#timeupdateListeners) cb(nextPos);
  }
}
