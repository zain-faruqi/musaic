import type {
  AdapterFactory,
  PlaybackAdapter,
  PlaybackError,
  PlaybackState,
  PlayerState,
  PlayerStateListener,
  Queue,
  UnifiedTrack,
  Unsubscribe,
} from './types';
import { PRELOAD_LEAD_MS, PREVIOUS_RESTART_THRESHOLD_MS } from './constants';

type Slot = {
  readonly adapter: PlaybackAdapter;
  readonly track: UnifiedTrack;
  readonly unsubs: readonly Unsubscribe[];
};

type SetQueueOptions = {
  readonly cursor?: number;
  readonly autoplay?: boolean;
};

type PlayerManagerOptions = {
  readonly createAdapter: AdapterFactory;
  readonly initialVolume?: number;
};

const EMPTY_QUEUE: Queue = { items: [], cursor: 0 };

/**
 * Recognize an adapter-emitted error that carries structured playback
 * failure info (YouTubeUnplayableError; Spotify's region-locked /
 * premium-required / content-removed / auth-required cases).
 * Structural duck-type rather than `instanceof` so PlayerManager
 * doesn't have to import every adapter's error class — that would
 * invert the dependency direction (adapter-internal concepts must
 * not leak upward into PlayerManager).
 *
 * Returns the PlaybackError-shaped fields if the err qualifies, null
 * otherwise. UI uses these to render targeted affordances; non-
 * categorized errors still flip `playbackState` to 'error' (the
 * generic fallback) but leave `playbackError` null.
 *
 * The accepted reason set is source-agnostic — when a new source
 * adds a reason, both this whitelist and `PlaybackError.reason`'s
 * literal union extend together. They're kept in sync by the
 * `KNOWN_REASONS` set below so a future addition is one edit.
 */
const KNOWN_REASONS: ReadonlySet<PlaybackError['reason']> = new Set([
  'not-found',
  'embed-disallowed',
  'region-locked',
  'premium-required',
  'content-removed',
  'auth-required',
  'unknown',
]);

const asPlaybackError = (err: unknown): PlaybackError | null => {
  if (!(err instanceof Error)) return null;
  const candidate = err as Error & { reason?: unknown; watchUrl?: unknown };
  if (
    typeof candidate.reason !== 'string' ||
    !KNOWN_REASONS.has(candidate.reason as PlaybackError['reason'])
  ) {
    return null;
  }
  const watchUrl = typeof candidate.watchUrl === 'string' ? candidate.watchUrl : undefined;
  return {
    reason: candidate.reason as PlaybackError['reason'],
    ...(watchUrl !== undefined && { watchUrl }),
  };
};

/**
 * Apply the adapter's reported duration to the track if it disagrees
 * with the currently-stored value. Used both at load (initial sample)
 * and on each timeupdate (catch mid-playback revisions).
 *
 * Returns the same slot if no change, a new slot if duration updated.
 */
const correctSlotDuration = (slot: Slot): Slot => {
  const reported = slot.adapter.getDurationMs();
  if (reported > 0 && reported !== slot.track.durationMs) {
    return {
      ...slot,
      track: { ...slot.track, durationMs: reported },
    };
  }
  return slot;
};

/**
 * PlayerManager — owns the queue and orchestrates all playback adapters.
 *
 * Holds at most two live adapter slots: `current` and `next` (preloaded).
 * No "previous" slot.
 *
 * Invariants:
 *   - Exactly one adapter is audible at a time.
 *   - Preloaded adapters are loaded but muted.
 *   - User actions cancel pending preloads.
 *   - Handoff order: unmute new, verify playing, then unload old.
 *
 * Duration handling: track.durationMs from metadata is a hint only;
 * adapter.getDurationMs() is authoritative once load() resolves. We
 * sample at load and re-sample on each timeupdate (Chromium can revise
 * <audio>.duration mid-playback as more frames decode — without re-
 * sampling, scrubber clicks land at the wrong proportional position).
 */
export class PlayerManager {
  readonly #createAdapter: AdapterFactory;
  readonly #stateListeners = new Set<PlayerStateListener>();

  #queue: Queue = EMPTY_QUEUE;
  #current: Slot | null = null;
  #next: Slot | null = null;
  #playbackState: PlaybackState = 'idle';
  #positionMs = 0;
  #userVolume: number;
  #preloadStarted = false;
  #opId = 0;
  #disposed = false;
  /**
   * Once-only guard for `#onCurrentEnded`. Both the adapter's own
   * `ended` event and the PlayerManager-level watchdog (in
   * `#onCurrentTimeupdate`) call into `#onCurrentEnded`; either can
   * fire first, but only one should win per current-track session.
   * Reset to false whenever a new `#current` is established.
   *
   * Why the watchdog exists: in packaged builds, the Spotify adapter's
   * own ended detection (interpolation + poll fallback) sometimes fails
   * to fire despite firing reliably in unit tests. The watchdog is
   * belt-and-braces — if the adapter's timeupdate emits a position ≥
   * duration and ended hasn't fired, the auto-advance triggers anyway.
   * See the matching console.warn line in `#onCurrentTimeupdate`.
   */
  #endedHandled = false;
  /**
   * Categorized failure info for the current track, or null. Set when
   * the current adapter emits a structured error (today: YouTube's
   * embed-disallowed / not-found / unknown). Cleared on every track
   * transition — see `#clearPlaybackError` callsites.
   */
  #playbackError: PlaybackError | null = null;

  constructor(options: PlayerManagerOptions) {
    this.#createAdapter = options.createAdapter;
    this.#userVolume = clampVolume(options.initialVolume ?? 1);
  }

  async setQueue(
    tracks: readonly UnifiedTrack[],
    options: SetQueueOptions = {},
  ): Promise<void> {
    this.#assertNotDisposed();
    const opId = this.#bumpOpId();

    const cursor = clampCursor(options.cursor ?? 0, tracks.length);
    const autoplay = options.autoplay ?? true;

    await this.#disposeAll();

    this.#queue = { items: tracks, cursor };
    this.#preloadStarted = false;
    this.#positionMs = 0;
    this.#endedHandled = false;

    if (tracks.length === 0) {
      this.#playbackState = 'idle';
      this.#emit();
      return;
    }

    const track = tracks[cursor];
    if (!track) {
      this.#playbackState = 'idle';
      this.#emit();
      return;
    }

    await this.#loadAsCurrent(track, opId);
    if (this.#opId !== opId) return;

    if (autoplay) {
      await this.#playCurrent(opId);
    } else {
      this.#playbackState = 'paused';
    }
    this.#emit();
  }

  async play(): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#current) {
      const track = this.#queue.items[this.#queue.cursor];
      if (!track) return;
      const opId = this.#bumpOpId();
      await this.#loadAsCurrent(track, opId);
      if (this.#opId !== opId) return;
      await this.#playCurrent(opId);
      this.#emit();
      return;
    }
    const opId = this.#opId;
    await this.#playCurrent(opId);
    this.#emit();
  }

  async pause(): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#current) return;
    await this.#current.adapter.pause();
    this.#playbackState = 'paused';
    this.#emit();
  }

  async togglePlayPause(): Promise<void> {
    if (this.#playbackState === 'playing') {
      await this.pause();
    } else {
      await this.play();
    }
  }

  async next(): Promise<void> {
    this.#assertNotDisposed();
    const nextCursor = this.#queue.cursor + 1;
    if (nextCursor >= this.#queue.items.length) return;
    await this.#advanceTo(nextCursor);
  }

  async previous(): Promise<void> {
    this.#assertNotDisposed();
    if (this.#current && this.#positionMs > PREVIOUS_RESTART_THRESHOLD_MS) {
      await this.seek(0);
      return;
    }
    const prevCursor = this.#queue.cursor - 1;
    if (prevCursor < 0) {
      if (this.#current) await this.seek(0);
      return;
    }
    await this.#advanceTo(prevCursor);
  }

  async seek(ms: number): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#current) return;
    await this.#current.adapter.seek(ms);
  }

  async jumpTo(cursor: number): Promise<void> {
    this.#assertNotDisposed();
    if (cursor < 0 || cursor >= this.#queue.items.length) return;
    if (cursor === this.#queue.cursor && this.#current) {
      await this.seek(0);
      return;
    }
    await this.#advanceTo(cursor);
  }

  /**
   * Append a track to the end of the queue. Synchronous: no adapter
   * work happens here — `#current` and `#next` are untouched, the
   * preload state machine is untouched. The next `timeupdate` callback
   * (~200–250ms) will see the longer queue and, if the current track
   * is inside the preload window with no preload yet started, kick
   * off preload for the appended track.
   *
   * Why this is safe (the preload-no-op guard concern):
   *   - `#preloadStarted` is set to `true` only at the moment preload
   *     actually fires — inside the `if` body in `#onCurrentTimeupdate`,
   *     after the queue-non-empty check. When the queue ends at the
   *     current track, the condition short-circuits on
   *     `this.#queue.items[this.#queue.cursor + 1]` being undefined and
   *     we exit without setting the flag.
   *   - So "entered the preload window, queue was empty, no-op happened"
   *     does NOT poison the flag. The next timeupdate after enqueue
   *     re-evaluates with the new queue and fires preload normally.
   *   - Other reset points (`#loadAsCurrent`, `#promoteNext`,
   *     `#disposeNext`, `setQueue`) cover the legitimate state changes.
   *
   * Locked in by a test: see "enqueue late in playback" in
   * PlayerManager.test.ts.
   *
   * Idle / empty-queue case: if the manager is currently idle and the
   * queue is empty before enqueue, this method just makes the queue
   * non-empty. It does NOT autoplay — call `play()` afterwards if you
   * want that. This matches Spotify / Apple Music's "Add to Queue":
   * append is append; starting playback is a separate gesture.
   */
  enqueue(track: UnifiedTrack): void {
    this.#assertNotDisposed();
    this.#queue = {
      ...this.#queue,
      items: [...this.#queue.items, track],
    };
    this.#emit();
  }

  setVolume(v: number): void {
    this.#assertNotDisposed();
    this.#userVolume = clampVolume(v);
    if (this.#current) {
      void this.#current.adapter.setVolume(this.#userVolume);
    }
    this.#emit();
  }

  /**
   * Clear the structured playback error. UI calls this when the user
   * acknowledges a non-actionable failure (the "dismiss" button for
   * `'not-found'` or `'unknown'` reasons in NowPlayingBar). No-op if
   * no error is set.
   *
   * Doesn't touch `playbackState` — if the manager is in `'error'`,
   * playback is still broken; the user-acknowledgement only hides
   * the affordance. The state self-resolves on the next track load.
   */
  dismissError(): void {
    this.#assertNotDisposed();
    if (this.#playbackError === null) return;
    this.#playbackError = null;
    this.#emit();
  }

  getState(): PlayerState {
    return this.#snapshot();
  }

  on(_event: 'state', cb: PlayerStateListener): Unsubscribe {
    this.#stateListeners.add(cb);
    return () => {
      this.#stateListeners.delete(cb);
    };
  }

  getVisualElement(): HTMLElement | null {
    return this.#current?.adapter.getVisualElement() ?? null;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bumpOpId();
    await this.#disposeAll();
    this.#stateListeners.clear();
  }

  // --- Internals ----------------------------------------------------------

  #bumpOpId(): number {
    return ++this.#opId;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('PlayerManager: already disposed');
  }

  async #loadAsCurrent(track: UnifiedTrack, opId: number): Promise<void> {
    this.#playbackState = 'loading';
    // Any prior error belongs to the prior track. Clearing here covers
    // setQueue, skip, jumpTo, and the post-ended advance — all routes
    // that allocate a fresh adapter via this method.
    this.#playbackError = null;
    this.#emit();

    const adapter = this.#createAdapter(track.source);
    try {
      await adapter.load(track);
    } catch (err) {
      if (this.#opId !== opId) {
        await safeUnload(adapter);
        return;
      }
      this.#playbackState = 'error';
      console.error('PlayerManager: load failed', err);
      await safeUnload(adapter);
      this.#emit();
      return;
    }

    if (this.#opId !== opId) {
      await safeUnload(adapter);
      return;
    }

    await adapter.setVolume(this.#userVolume);

    const unsubs: Unsubscribe[] = [
      adapter.on('timeupdate', (ms) => this.#onCurrentTimeupdate(ms, opId)),
      adapter.on('ended', () => this.#onCurrentEnded(opId)),
      adapter.on('error', (err) => this.#onCurrentError(err, opId)),
    ];
    // Initial sample of adapter duration. Replaces metadata estimate.
    this.#current = correctSlotDuration({ adapter, track, unsubs });
    this.#preloadStarted = false;
    this.#positionMs = 0;
    this.#endedHandled = false;
  }

  async #playCurrent(opId: number): Promise<void> {
    if (!this.#current) return;
    try {
      await this.#current.adapter.play();
    } catch (err) {
      if (this.#opId !== opId) return;
      this.#playbackState = 'error';
      console.error('PlayerManager: play failed', err);
      this.#emit();
      return;
    }
    if (this.#opId !== opId) return;
    this.#playbackState = 'playing';
  }

  async #advanceTo(targetCursor: number): Promise<void> {
    const opId = this.#bumpOpId();
    const targetTrack = this.#queue.items[targetCursor];
    if (!targetTrack) return;

    if (
      targetCursor === this.#queue.cursor + 1 &&
      this.#next &&
      this.#next.track.id === targetTrack.id
    ) {
      await this.#promoteNext(opId, targetCursor);
      return;
    }

    await this.#disposeNext();
    await this.#disposeCurrent();
    if (this.#opId !== opId) return;

    this.#queue = { ...this.#queue, cursor: targetCursor };
    await this.#loadAsCurrent(targetTrack, opId);
    if (this.#opId !== opId) return;
    await this.#playCurrent(opId);
    this.#emit();
  }

  async #promoteNext(opId: number, newCursor: number): Promise<void> {
    if (!this.#next) return;
    const promoted = this.#next;
    const old = this.#current;

    await promoted.adapter.setVolume(this.#userVolume);
    if (this.#opId !== opId) return;

    try {
      await promoted.adapter.play();
    } catch (err) {
      if (this.#opId !== opId) return;
      this.#playbackState = 'error';
      console.error('PlayerManager: handoff play failed', err);
      this.#emit();
      return;
    }
    if (this.#opId !== opId) return;

    if (old) {
      void disposeSlot(old);
    }

    for (const u of promoted.unsubs) u();
    const adapter = promoted.adapter;
    const newUnsubs: Unsubscribe[] = [
      adapter.on('timeupdate', (ms) => this.#onCurrentTimeupdate(ms, opId)),
      adapter.on('ended', () => this.#onCurrentEnded(opId)),
      adapter.on('error', (err) => this.#onCurrentError(err, opId)),
    ];

    // Re-sample duration when promoting — the preloaded adapter's
    // duration may have settled to a different value than at preload.
    this.#current = correctSlotDuration({ adapter, track: promoted.track, unsubs: newUnsubs });
    this.#next = null;
    this.#queue = { ...this.#queue, cursor: newCursor };
    this.#playbackState = 'playing';
    this.#positionMs = 0;
    this.#preloadStarted = false;
    this.#endedHandled = false;
    // Handoff path bypasses #loadAsCurrent — clear any error from the
    // outgoing track here so the new current starts clean.
    this.#playbackError = null;
    this.#emit();
  }

  #onCurrentTimeupdate(ms: number, opId: number): void {
    if (this.#opId !== opId || !this.#current) return;
    this.#positionMs = ms;

    // Re-sample adapter duration each tick. Chromium revises
    // <audio>.duration as it discovers more decodable frames in
    // some MP3 files (notably those with trailing padding/junk that
    // decodes as additional silent frames). Without this, the scrubber
    // stays scaled to the load-time estimate and clicks land at the
    // wrong proportional position once the audio plays past it.
    //
    // Cheap: getter call + number compare per timeupdate (~5x/sec).
    // Allocation only happens on the rare ticks where duration changes.
    const corrected = correctSlotDuration(this.#current);
    if (corrected !== this.#current) {
      this.#current = corrected;
    }

    // ---- Ended watchdog ----
    //
    // Belt-and-braces for Spotify natural-end detection. The
    // SpotifyAdapter has two paths to fire ended (event-based on
    // paused-at-zero with interpolated prior near duration, and
    // poll-based on interpolated position ≥ duration), both unit-
    // test-covered, but neither holds up reliably in packaged-build
    // smoke. The mystery is what the real SDK is firing in packaged
    // Electron that the unit tests don't model.
    //
    // This watchdog is at the PlayerManager level rather than inside
    // the adapter so it's robust against ANY adapter's ended-detection
    // misses. When the position the adapter has just emitted is ≥
    // the slot's duration and `#endedHandled` is still false, force
    // the auto-advance. `#onCurrentEnded` is now idempotent so the
    // adapter's own (delayed) ended event arriving later is a no-op.
    if (
      !this.#endedHandled &&
      this.#current.track.durationMs > 0 &&
      ms >= this.#current.track.durationMs
    ) {
      console.warn(
        `PlayerManager: ended watchdog firing (position ${ms}` +
          ` ≥ duration ${this.#current.track.durationMs}) — adapter's own ended` +
          ` event has not arrived`,
      );
      this.#onCurrentEnded(opId);
      return;
    }

    const remaining = this.#current.track.durationMs - ms;
    if (
      remaining <= PRELOAD_LEAD_MS &&
      remaining > 0 &&
      !this.#preloadStarted &&
      !this.#next &&
      this.#queue.items[this.#queue.cursor + 1]
    ) {
      this.#preloadStarted = true;
      void this.#preloadNext(opId);
    }

    this.#emit();
  }

  #onCurrentEnded(opId: number): void {
    if (this.#opId !== opId) return;
    if (this.#endedHandled) return;
    this.#endedHandled = true;
    void this.#handleEnded(opId);
  }

  #onCurrentError(err: Error, opId: number): void {
    if (this.#opId !== opId) return;
    this.#playbackState = 'error';
    // Promote structured errors (YouTubeUnplayableError today, Spotify's
    // unplayable cases later) onto PlayerState.playbackError so UI can
    // render targeted affordances. Generic errors leave the field null
    // and rely on the playbackState='error' fallback.
    this.#playbackError = asPlaybackError(err);
    console.error('PlayerManager: current adapter error', err);
    this.#emit();
  }

  async #handleEnded(opId: number): Promise<void> {
    const newCursor = this.#queue.cursor + 1;
    const newTrack = this.#queue.items[newCursor];

    if (!newTrack) {
      await this.#disposeCurrent();
      if (this.#opId !== opId) return;
      this.#playbackState = 'idle';
      this.#positionMs = 0;
      this.#emit();
      return;
    }

    if (this.#next && this.#next.track.id === newTrack.id) {
      await this.#promoteNext(opId, newCursor);
      return;
    }

    await this.#disposeCurrent();
    if (this.#opId !== opId) return;
    this.#queue = { ...this.#queue, cursor: newCursor };
    await this.#loadAsCurrent(newTrack, opId);
    if (this.#opId !== opId) return;
    await this.#playCurrent(opId);
    this.#emit();
  }

  async #preloadNext(opId: number): Promise<void> {
    const nextTrack = this.#queue.items[this.#queue.cursor + 1];
    if (!nextTrack) return;

    // ---- YouTube preload skip ----
    //
    // YouTube's priming step (the muted-play dance that load() used to
    // do to satisfy Chromium's autoplay policy) has been removed —
    // see youtube-adapter.ts. With priming gone, the whole reason to
    // preload YouTube during the previous track's last few seconds
    // disappears: there's no warmup work to amortize against the
    // playback window, just a `loadVideoById` that's effectively free
    // at handoff. Preloading would still call load(), which would
    // create an iframe that sits idle for several seconds before
    // handoff and then would have to be torn down or promoted; the
    // iframe creation overhead is real and the gain is now zero. So
    // cold-start at handoff (in #loadAsCurrent's call out of
    // #handleEnded) instead.
    //
    // Trade-off: ~500–1500ms gap between the previous track ending
    // and YouTube audio starting (iframe creation + cueVideoById +
    // playVideo round-trip via postMessage). The user can still click
    // Next manually to skip the wait if they want (which uses the
    // same code path but with user activation in scope, satisfying
    // any autoplay-policy heuristics Chromium applies).
    if (nextTrack.source === 'youtube') return;

    let adapter: PlaybackAdapter;
    try {
      adapter = this.#createAdapter(nextTrack.source);
    } catch (err) {
      console.warn('PlayerManager: preload skipped — no adapter for source', nextTrack.source, err);
      return;
    }

    try {
      await adapter.load(nextTrack);
    } catch (err) {
      if (this.#opId !== opId) {
        await safeUnload(adapter);
        return;
      }
      console.warn('PlayerManager: preload load failed', err);
      await safeUnload(adapter);
      return;
    }

    if (this.#opId !== opId) {
      await safeUnload(adapter);
      return;
    }

    await adapter.setVolume(0);

    const unsubs: Unsubscribe[] = [
      adapter.on('error', (err) => {
        console.warn('PlayerManager: preloaded next adapter error', err);
      }),
    ];
    this.#next = correctSlotDuration({ adapter, track: nextTrack, unsubs });
    this.#emit();
  }

  async #disposeAll(): Promise<void> {
    await this.#disposeNext();
    await this.#disposeCurrent();
  }

  async #disposeCurrent(): Promise<void> {
    if (!this.#current) return;
    const c = this.#current;
    this.#current = null;
    // Any structured error referred to the current track — once we
    // let go of that adapter, the error no longer applies. Covers
    // end-of-queue and setQueue([]) which don't otherwise route
    // through #loadAsCurrent.
    this.#playbackError = null;
    await disposeSlot(c);
  }

  async #disposeNext(): Promise<void> {
    if (!this.#next) return;
    const n = this.#next;
    this.#next = null;
    this.#preloadStarted = false;
    await disposeSlot(n);
  }

  #emit(): void {
    if (this.#stateListeners.size === 0) return;
    const snap = this.#snapshot();
    for (const cb of this.#stateListeners) cb(snap);
  }

  #snapshot(): PlayerState {
    return {
      queue: this.#queue,
      current: this.#current?.track ?? null,
      next: this.#next?.track ?? null,
      playbackState: this.#playbackState,
      positionMs: this.#positionMs,
      volume: this.#userVolume,
      canGoPrevious: this.#queue.cursor > 0 || this.#positionMs > 0,
      canGoNext: this.#queue.cursor + 1 < this.#queue.items.length,
      playbackError: this.#playbackError,
    };
  }
}

const clampVolume = (v: number): number => Math.max(0, Math.min(1, v));

const clampCursor = (cursor: number, length: number): number => {
  if (length === 0) return 0;
  return Math.max(0, Math.min(cursor, length - 1));
};

const disposeSlot = async (slot: Slot): Promise<void> => {
  for (const u of slot.unsubs) u();
  await safeUnload(slot.adapter);
};

const safeUnload = async (adapter: PlaybackAdapter): Promise<void> => {
  try {
    await adapter.unload();
  } catch (err) {
    console.warn('PlayerManager: adapter unload failed', err);
  }
};
