/**
 * Source of a track. Discriminated-union-ready: switch on this and
 * let `never` catch missing cases.
 */
export type Source = 'local' | 'youtube' | 'spotify';

/**
 * Source-agnostic track shape used everywhere outside adapter internals.
 *
 * `durationMs` from upstream sources (e.g. music-metadata extraction)
 * is a hint, not a guarantee. PlayerManager overrides it with the
 * adapter's `getDurationMs()` once a track is loaded — adapters know
 * the true playable length, which can disagree with metadata estimates
 * (different MP3 decoders find different decodable frame counts in
 * the same file).
 */
export type UnifiedTrack = {
  readonly id: string;
  readonly source: Source;
  readonly sourceId: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly durationMs: number;
  readonly artwork?: string;
  readonly album?: string;
  readonly isrc?: string;
};

export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/**
 * Categorized playback failure surfaced to UI when the current
 * adapter can't play its track.
 *
 * `reason` is source-agnostic on purpose. YouTube ships three
 * (`not-found`, `embed-disallowed`, `unknown`); Spotify
 * adds four (`region-locked`, `premium-required`, `content-removed`,
 * `auth-required`). New sources extend the literal union; UI
 * fallback message is `'unknown'`.
 *
 * `watchUrl` is the canonical external URL for the track, populated
 * by the adapter (which knows the source's URL shape). Despite the
 * YouTube-flavored name, the field is source-agnostic: Spotify's
 * adapter populates it with `https://open.spotify.com/track/<id>`.
 * NowPlayingBar uses it for the "open externally" affordance and
 * picks per-source button copy based on the source of the current
 * track.
 *
 */
export type PlaybackError = {
  readonly reason:
    | 'not-found'
    | 'embed-disallowed'
    | 'region-locked'
    | 'premium-required'
    | 'content-removed'
    | 'auth-required'
    | 'unknown';
  readonly watchUrl?: string;
};

export type Unsubscribe = () => void;

/**
 * The PlaybackAdapter contract. Every source implements the full contract.
 *
 * Invariants:
 *   - `load` does not play. It prepares; volume is user-controlled.
 *   - Position is reported in milliseconds (never seconds).
 *   - On `unload`, all listeners / timers / polls are released.
 *   - Errors thrown or emitted include the source name in the message.
 *   - `on()` returns an Unsubscribe handle.
 *   - `getDurationMs()` is authoritative — PlayerManager prefers it
 *     over the loaded track's metadata duration. May change after load
 *     (e.g. Chromium revising duration mid-playback as more frames
 *     decode); PlayerManager re-samples on each timeupdate.
 */
export type PlaybackAdapter = {
  readonly source: Source;
  load(track: UnifiedTrack): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  unload(): Promise<void>;
  getPositionMs(): number;
  /**
   * The actual loaded duration as the adapter knows it. Returns 0 if no
   * track is loaded or the adapter doesn't yet have duration info.
   * Source of truth for "where will playback end" — overrides the
   * track's metadata-supplied durationMs.
   */
  getDurationMs(): number;
  /**
   * Returns the DOM node the adapter wants displayed in the video panel.
   * `<video>` for local video files, `<iframe>` for YouTube, `null` for
   * audio-only sources (local audio, Spotify) — the panel collapses on
   * null. Widening from `HTMLVideoElement` to `HTMLElement` is what
   * admits YouTube's iframe.
   */
  getVisualElement(): HTMLElement | null;
  on(event: 'timeupdate', cb: (positionMs: number) => void): Unsubscribe;
  on(event: 'ended', cb: () => void): Unsubscribe;
  on(event: 'error', cb: (err: Error) => void): Unsubscribe;
};

export type AdapterFactory = (source: Source) => PlaybackAdapter;

export type Queue = {
  readonly items: readonly UnifiedTrack[];
  readonly cursor: number;
};

export type PlayerState = {
  readonly queue: Queue;
  readonly current: UnifiedTrack | null;
  readonly next: UnifiedTrack | null;
  readonly playbackState: PlaybackState;
  readonly positionMs: number;
  readonly volume: number;
  readonly canGoPrevious: boolean;
  readonly canGoNext: boolean;
  /**
   * Categorized playback failure for the current track. Null when
   * playback is fine. Set by PlayerManager when the current adapter
   * emits an error it can categorize (today: YouTubeUnplayableError).
   * Cleared on any track change.
   */
  readonly playbackError: PlaybackError | null;
};

export type PlayerStateListener = (state: PlayerState) => void;
