import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  YouTubeAdapter,
  YouTubeUnplayableError,
  youtubeErrorCodeToReason,
} from './youtube-adapter';
import type { YTGlobal, YTPlayer, YTPlayerConstructor } from './iframe-api-loader';
import type { UnifiedTrack } from '@renderer/core/types';

/**
 * Minimal fake of the YT.Player surface the adapter touches.
 *
 * Exposes trigger methods (`fireStateChange`, etc) so tests can simulate
 * the IFrame API's events. State (volume, currentTime, duration) is
 * plain fields; the SDK getters read them directly so tests can drive
 * them.
 */
class FakeYTPlayer implements YTPlayer {
  // Driveable state ------------------------------------------------------
  volume = 100;
  muted = false;
  currentTime = 0;
  duration = 60;
  playerState = -1; // unstarted

  // Call accounting ------------------------------------------------------
  cueVideoCalls: string[] = [];
  loadVideoCalls: string[] = [];
  playCount = 0;
  pauseCount = 0;
  stopCount = 0;
  seekCalls: Array<{ seconds: number; allowSeekAhead: boolean }> = [];
  setVolumeCalls: number[] = [];
  muteCount = 0;
  unMuteCount = 0;
  destroyCount = 0;

  destroyShouldThrow = false;

  /**
   * Constructor config the YT API was called with — playerVars,
   * videoId, host, etc. Captured by the PlayerCtor in buildFakeYT.
   * Tests assert on this for things like "playerVars.autoplay is 1"
   * without needing to spy the constructor itself.
   */
  ctorConfig: ConstructorParameters<YTPlayerConstructor>[1] | null = null;

  /**
   * If true (default), `playVideo()` synchronously fires the
   * onStateChange handler with PLAYING. This is how the priming step
   * inside YouTubeAdapter.load() unblocks during tests — the real YT
   * player fires PLAYING via a postMessage round-trip, but we collapse
   * that here. Tests that want to exercise the timeout path can set
   * this to false.
   */
  autoFirePlayingOnPlay = true;

  // Adapter-injected event handlers --------------------------------------
  onStateChange: ((ev: { data: number; target: YTPlayer }) => void) | null = null;
  onError: ((ev: { data: number; target: YTPlayer }) => void) | null = null;

  // Methods --------------------------------------------------------------
  cueVideoById(videoId: string): void {
    this.cueVideoCalls.push(videoId);
  }
  loadVideoById(videoId: string): void {
    this.loadVideoCalls.push(videoId);
  }
  playVideo(): void {
    this.playCount++;
    this.playerState = 1;
    // Synthesize the state-change event the real player would emit.
    // Asynchronous (microtask) to match real behavior — the adapter's
    // priming code awaits a promise; firing inline would cause the
    // resolve to land before the awaiter is set up.
    if (this.autoFirePlayingOnPlay) {
      void Promise.resolve().then(() => {
        this.onStateChange?.({ data: 1, target: this });
      });
    }
  }
  pauseVideo(): void {
    this.pauseCount++;
    this.playerState = 2;
  }
  stopVideo(): void {
    this.stopCount++;
    this.playerState = 0;
  }
  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.seekCalls.push({ seconds, allowSeekAhead });
    this.currentTime = seconds;
  }
  setVolume(volumePercent: number): void {
    this.setVolumeCalls.push(volumePercent);
    this.volume = volumePercent;
  }
  getVolume(): number {
    return this.volume;
  }
  mute(): void {
    this.muteCount++;
    this.muted = true;
  }
  unMute(): void {
    this.unMuteCount++;
    this.muted = false;
  }
  isMuted(): boolean {
    return this.muted;
  }
  getCurrentTime(): number {
    return this.currentTime;
  }
  getDuration(): number {
    return this.duration;
  }
  getPlayerState(): number {
    return this.playerState;
  }
  destroy(): void {
    this.destroyCount++;
    if (this.destroyShouldThrow) throw new Error('fake: destroy boom');
  }
  getIframe(): HTMLIFrameElement {
    // The diagnostic logging in YouTubeAdapter#prime calls this; the
    // tests don't assert anything about the iframe shape, so return a
    // bare stub. Casting through unknown is safe here — we never read
    // anything off the returned value except via the logging path,
    // which goes through `getBoundingClientRect()` and tolerates the
    // call returning a structurally-loose object.
    return {
      getBoundingClientRect: (): DOMRect =>
        ({
          x: 0,
          y: 0,
          width: 270,
          height: 270,
          top: 0,
          left: 0,
          right: 270,
          bottom: 270,
          toJSON: () => ({}),
        }) as DOMRect,
    } as unknown as HTMLIFrameElement;
  }

  // Test driver helpers --------------------------------------------------
  fireEnded(): void {
    this.playerState = 0;
    this.onStateChange?.({ data: 0, target: this });
  }
  firePlaying(): void {
    this.playerState = 1;
    this.onStateChange?.({ data: 1, target: this });
  }
  firePaused(): void {
    this.playerState = 2;
    this.onStateChange?.({ data: 2, target: this });
  }
  fireErrorCode(code: number): void {
    this.onError?.({ data: code, target: this });
  }
}

/**
 * Fake container element. Tests need an HTMLElement-shaped object that
 * supports `appendChild`. We use a very small subtype rather than
 * pulling in jsdom — the adapter only touches `appendChild` and
 * `isConnected` on the elements it creates, both of which our fakes
 * satisfy.
 */
const createFakeContainer = (): HTMLElement => {
  const children: HTMLElement[] = [];
  // Casts here intentional: the structural surface used by the adapter
  // is tiny (appendChild only), and a full HTMLElement implementation
  // is overkill. Same approach as LocalAdapter tests use for media
  // elements.
  const el = {
    appendChild: (child: HTMLElement): HTMLElement => {
      children.push(child);
      // Patch the child so its `isConnected` and `parentNode` look
      // right while attached.
      Object.defineProperty(child, 'isConnected', {
        configurable: true,
        get: () => children.includes(child),
      });
      Object.defineProperty(child, 'parentNode', {
        configurable: true,
        get: () => (children.includes(child) ? el : null),
      });
      return child;
    },
    // Used by the adapter's cleanup path when removing the mount el.
    removeChild: (child: HTMLElement): HTMLElement => {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      return child;
    },
  } as unknown as HTMLElement;
  return el;
};

const createFakeMountElement = (): HTMLElement => {
  const el = {
    id: '',
    isConnected: false,
    parentNode: null as { removeChild: (c: HTMLElement) => HTMLElement } | null,
  } as unknown as HTMLElement;
  return el;
};

/**
 * Build a `YTGlobal`-shaped object whose `Player` constructor records
 * the adapter's onReady/onStateChange/onError callbacks onto the
 * created FakeYTPlayer and (optionally) fires onReady asynchronously.
 */
const buildFakeYT = (opts: { fireReady?: boolean } = {}): {
  yt: YTGlobal;
  players: FakeYTPlayer[];
} => {
  const players: FakeYTPlayer[] = [];
  const PlayerCtor = function PlayerCtor(
    this: FakeYTPlayer,
    _mount: HTMLElement | string,
    config: ConstructorParameters<YTPlayerConstructor>[1],
  ) {
    const player = new FakeYTPlayer();
    player.ctorConfig = config;
    players.push(player);
    player.onStateChange = config.events?.onStateChange ?? null;
    player.onError = config.events?.onError ?? null;
    // Fire onReady on a microtask — the real API fires async, and the
    // adapter's `await new Promise(...)` needs to see the resolution.
    if (opts.fireReady !== false) {
      void Promise.resolve().then(() => {
        config.events?.onReady?.({ target: player });
      });
    }
    return player;
  } as unknown as YTPlayerConstructor;

  const yt: YTGlobal = {
    Player: PlayerCtor,
    PlayerState: {
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5,
    },
  };
  return { yt, players };
};

const VIDEO_ID = 'dQw4w9WgXcQ';

const ytTrack: UnifiedTrack = {
  id: 'yt-1',
  source: 'youtube',
  sourceId: VIDEO_ID,
  title: 'Never Gonna Give You Up',
  artists: ['Rick Astley'],
  durationMs: 213_000,
};

const setup = (opts: { fireReady?: boolean } = {}) => {
  const container = createFakeContainer();
  const { yt, players } = buildFakeYT(opts);
  const loadIframeApi = vi.fn().mockResolvedValue(yt);
  const adapter = new YouTubeAdapter({
    loadIframeApi,
    getContainer: () => container,
    createMountElement: createFakeMountElement,
  });
  return { adapter, container, players, loadIframeApi };
};

/**
 * Load and wait for the player's onReady microtask + priming to complete.
 *
 * After load() resolves, the player has been primed (mute → playVideo →
 * pause → unMute). For tests that target *post-load* user actions
 * (play / pause / seek / volume / events), the priming's call
 * accounting is noise — we reset the counters here so each test
 * asserts only on what the user-level action did.
 *
 * Tests that want to observe the priming itself use raw `setup()` and
 * `await adapter.load(...)` directly.
 */
const setupLoaded = async (track: UnifiedTrack = ytTrack) => {
  const s = setup();
  await s.adapter.load(track);
  for (const p of s.players) {
    p.playCount = 0;
    p.pauseCount = 0;
    p.setVolumeCalls = [];
    p.muteCount = 0;
    p.unMuteCount = 0;
    p.cueVideoCalls = [];
  }
  return s;
};

describe('YouTubeAdapter — load', () => {
  it('rejects tracks from non-youtube sources', async () => {
    const { adapter } = setup();
    const localTrack: UnifiedTrack = { ...ytTrack, source: 'local' };
    await expect(adapter.load(localTrack)).rejects.toThrow(/cannot load.*local/);
  });

  it('rejects when track.sourceId is empty', async () => {
    const { adapter } = setup();
    await expect(
      adapter.load({ ...ytTrack, sourceId: '' }),
    ).rejects.toThrow(/sourceId is empty/);
  });

  it('rejects when the video panel container is not registered', async () => {
    const adapter = new YouTubeAdapter({
      loadIframeApi: vi.fn().mockResolvedValue(buildFakeYT().yt),
      getContainer: () => null,
      createMountElement: createFakeMountElement,
    });
    await expect(adapter.load(ytTrack)).rejects.toThrow(/container not registered/);
  });

  it(
    'sets playerVars.autoplay=1 and playerVars.mute=1 — required for cross-origin iframe autoplay permission',
    async () => {
      // The YT IFrame Player API only adds `allow="autoplay"` to the
      // iframe element it creates when playerVars.autoplay=1. That
      // attribute is what Chromium's cross-origin iframe Permissions
      // Policy reads to decide whether the iframe is permitted to
      // autoplay (independent of the renderer's webPreferences
      // autoplayPolicy, which doesn't propagate cross-origin).
      //
      // mute=1 pairs with autoplay=1 so the auto-start at iframe-
      // load time is muted; muted autoplay is universally allowed,
      // which is the belt-and-braces that makes this work even on
      // profiles with no prior interaction history. adapter.play()
      // then unMute()s to make the audio audible.
      const s = setup();
      await s.adapter.load(ytTrack);
      const player = s.players[0]!;
      expect(player.ctorConfig).not.toBeNull();
      const pv = player.ctorConfig!.playerVars;
      expect(pv?.autoplay).toBe(1);
      expect(pv?.mute).toBe(1);
    },
  );

  it(
    'play() unMute()s the player — required to make autoplay=1+mute=1 audible',
    async () => {
      // load() leaves the player playing muted (autoplay=1+mute=1 in
      // playerVars). adapter.play() is responsible for unmuting so
      // the audio becomes audible. PlayerManager calls
      // adapter.setVolume() before adapter.play() in its play
      // orchestration, so volume is already correct at this point;
      // unMute is the only step needed to actually hear the track.
      const s = setup();
      await s.adapter.load(ytTrack);
      const player = s.players[0]!;
      expect(player.unMuteCount).toBe(0);
      await s.adapter.play();
      expect(player.unMuteCount).toBe(1);
      // playVideo is still called (defensive — handles paused-then-
      // play correctly even when load just auto-started playback).
      expect(player.playCount).toBe(1);
    },
  );

  it(
    'does not call cueVideoById or loadVideoById in load() — videoId is in the constructor + autoplay=1',
    async () => {
      // An earlier contract was: load() calls cueVideoById, leaving
      // the player in CUED state; play() calls playVideo(), which
      // Chromium's cross-origin iframe autoplay policy then has to
      // permit (no allow="autoplay" on the iframe → blocked when
      // play() runs from a non-gesture context).
      //
      // The current contract: the videoId is passed in the constructor and
      // playerVars sets autoplay=1, mute=1. The YT IFrame Player API
      // adds `allow="autoplay"` to the iframe element (the load-bearing
      // bit — that attribute is what permits the cross-origin autoplay
      // policy to grant playback from a non-user-gesture context). The
      // iframe auto-starts the video muted as soon as it loads, so
      // there's no need to cue/load it after construction. play() then
      // unMute()s to make the audio audible.
      const s = setup();
      await s.adapter.load(ytTrack);
      const player = s.players[0];
      expect(player).toBeDefined();
      expect(player!.cueVideoCalls).toEqual([]);
      expect(player!.loadVideoCalls).toEqual([]);
    },
  );

  it(
    'does not prime during load: no mute/play/pause/unMute dance',
    async () => {
      // Priming has been removed. The
      // muted-play dance is now achieved via playerVars.autoplay=1 +
      // mute=1 at construction time, not via JS-level mute()/playVideo()
      // calls. The fake YT player counts only JS-API calls, so the
      // expectations below remain correct under the autoplay-on-
      // construction approach. cueVideoById is no longer called either.
      //
      // Rationale (compressed): two earlier iterations attempted to fix a
      // cross-source-handoff video-render bug by making priming work
      // in a collapsed video panel. Neither held. Iteration 3 dropped
      // priming entirely per the original spec's fallback option (b).
      // Iteration 4 follows up by adding autoplay=1+mute=1 so the
      // iframe gets allow="autoplay", which is what was actually
      // blocking the cross-source auto-advance video-render.
      const s = setup();
      await s.adapter.load(ytTrack);
      const player = s.players[0]!;
      expect(player.muteCount).toBe(0);
      expect(player.playCount).toBe(0);
      expect(player.pauseCount).toBe(0);
      expect(player.unMuteCount).toBe(0);
      // No cueVideoById call either — videoId is set in the constructor
      // and autoplay=1 starts the video on iframe load.
      expect(player.cueVideoCalls).toEqual([]);
    },
  );

  it('awaits the iframe API loader before constructing the player', async () => {
    const container = createFakeContainer();
    let resolveApi: (yt: YTGlobal) => void = () => {};
    const apiPromise = new Promise<YTGlobal>((resolve) => {
      resolveApi = resolve;
    });
    const { yt, players } = buildFakeYT();
    const adapter = new YouTubeAdapter({
      loadIframeApi: () => apiPromise,
      getContainer: () => container,
      createMountElement: createFakeMountElement,
    });

    const loadPromise = adapter.load(ytTrack);
    // The player hasn't been created yet — API hasn't resolved.
    expect(players.length).toBe(0);

    resolveApi(yt);
    await loadPromise;
    expect(players.length).toBe(1);
  });
});

describe('YouTubeAdapter — guards before load', () => {
  it('rejects play() before load()', async () => {
    const { adapter } = setup();
    await expect(adapter.play()).rejects.toThrow(/before load/);
  });

  it('rejects pause() before load()', async () => {
    const { adapter } = setup();
    await expect(adapter.pause()).rejects.toThrow(/before load/);
  });

  it('rejects seek() before load()', async () => {
    const { adapter } = setup();
    await expect(adapter.seek(0)).rejects.toThrow(/before load/);
  });

  it('rejects setVolume() before load()', async () => {
    const { adapter } = setup();
    await expect(adapter.setVolume(0.5)).rejects.toThrow(/before load/);
  });
});

describe('YouTubeAdapter — play / pause', () => {
  it('calls playVideo() on play()', async () => {
    const { adapter, players } = await setupLoaded();
    await adapter.play();
    expect(players[0]!.playCount).toBe(1);
  });

  it('calls pauseVideo() on pause()', async () => {
    const { adapter, players } = await setupLoaded();
    await adapter.pause();
    expect(players[0]!.pauseCount).toBe(1);
  });
});

describe('YouTubeAdapter — seek', () => {
  it('converts ms to seconds and passes allowSeekAhead=true', async () => {
    const { adapter, players } = await setupLoaded();
    await adapter.seek(45_000);
    expect(players[0]!.seekCalls).toEqual([{ seconds: 45, allowSeekAhead: true }]);
  });

  it('clamps negative values to 0', async () => {
    const { adapter, players } = await setupLoaded();
    await adapter.seek(-1000);
    expect(players[0]!.seekCalls[0]?.seconds).toBe(0);
  });

  it('updates cached position immediately so getPositionMs reflects the seek', async () => {
    const { adapter } = await setupLoaded();
    await adapter.seek(15_000);
    expect(adapter.getPositionMs()).toBe(15_000);
  });
});

describe('YouTubeAdapter — setVolume', () => {
  it('converts 0..1 to 0..100', async () => {
    const { adapter, players } = await setupLoaded();
    await adapter.setVolume(0.5);
    expect(players[0]!.setVolumeCalls).toEqual([50]);
  });

  it('clamps to [0, 1]', async () => {
    const { adapter, players } = await setupLoaded();
    await adapter.setVolume(-1);
    await adapter.setVolume(2);
    expect(players[0]!.setVolumeCalls).toEqual([0, 100]);
  });
});

describe('YouTubeAdapter — events', () => {
  it('emits ended when the player fires state 0', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('ended', cb);
    players[0]!.fireEnded();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('does NOT emit ended on other state changes', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('ended', cb);
    players[0]!.firePlaying();
    players[0]!.firePaused();
    expect(cb).not.toHaveBeenCalled();
  });

  it('emits a YouTubeUnplayableError with source prefix', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(100);
    expect(cb).toHaveBeenCalledOnce();
    const err = cb.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(YouTubeUnplayableError);
    expect(err.message).toMatch(/^youtube:/);
    expect(err.message).toContain('100');
  });

  it('returns an unsubscribe handle that removes the listener', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    const off = adapter.on('ended', cb);
    off();
    players[0]!.fireEnded();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('YouTubeAdapter — error categorization', () => {
  it('maps error code 100 → reason "not-found"', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(100);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.reason).toBe('not-found');
    expect(err.code).toBe(100);
  });

  it('maps error code 101 → reason "embed-disallowed"', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(101);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.reason).toBe('embed-disallowed');
  });

  it('maps error code 150 → reason "embed-disallowed"', async () => {
    // 101 and 150 are functionally identical per the IFrame Player
    // API docs; the platform uses 150 in some embed-restriction
    // scenarios. Both must map the same way.
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(150);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.reason).toBe('embed-disallowed');
  });

  it('maps error code 2 → reason "unknown"', async () => {
    // 2 is "invalid parameter" — not user-actionable, falls into the
    // generic bucket.
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(2);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.reason).toBe('unknown');
  });

  it('maps error code 5 → reason "unknown"', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(5);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.reason).toBe('unknown');
  });

  it('maps unfamiliar codes → reason "unknown"', async () => {
    // The mapper is a closed set; anything outside it should fall
    // through to 'unknown' rather than throw.
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(999);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.reason).toBe('unknown');
  });

  it('populates watchUrl from the loaded videoId', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    players[0]!.fireErrorCode(101);
    const err = cb.mock.calls[0]?.[0] as YouTubeUnplayableError;
    expect(err.watchUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });
});

describe('youtubeErrorCodeToReason', () => {
  // The mapper is also tested via the adapter tests above, but a
  // direct test makes the contract reviewable in isolation.
  it('100 → not-found', () => {
    expect(youtubeErrorCodeToReason(100)).toBe('not-found');
  });
  it('101 → embed-disallowed', () => {
    expect(youtubeErrorCodeToReason(101)).toBe('embed-disallowed');
  });
  it('150 → embed-disallowed', () => {
    expect(youtubeErrorCodeToReason(150)).toBe('embed-disallowed');
  });
  it('2 → unknown', () => {
    expect(youtubeErrorCodeToReason(2)).toBe('unknown');
  });
  it('5 → unknown', () => {
    expect(youtubeErrorCodeToReason(5)).toBe('unknown');
  });
  it('anything else → unknown', () => {
    expect(youtubeErrorCodeToReason(0)).toBe('unknown');
    expect(youtubeErrorCodeToReason(99)).toBe('unknown');
    expect(youtubeErrorCodeToReason(999)).toBe('unknown');
  });
});

describe('YouTubeAdapter — timeupdate polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The IFrame API mock fires onReady on a microtask
  // (`Promise.resolve().then(...)`), and Vitest's fake timers don't fake
  // native Promise microtasks. `await adapter.load(...)` therefore
  // resolves naturally without needing `runAllTimersAsync` — which
  // would otherwise spin forever against `setInterval`'s self-
  // rescheduling, hit the 10k-iterations safety brake, and fail the
  // test.

  it('polls getCurrentTime and emits timeupdate in milliseconds', async () => {
    const s = setup();
    const cb = vi.fn();
    s.adapter.on('timeupdate', cb);

    await s.adapter.load(ytTrack);

    s.players[0]!.currentTime = 12.5;
    vi.advanceTimersByTime(200);
    expect(cb).toHaveBeenCalledWith(12_500);

    s.players[0]!.currentTime = 13.0;
    vi.advanceTimersByTime(200);
    expect(cb).toHaveBeenLastCalledWith(13_000);
  });

  it('updates getDurationMs from polled getDuration', async () => {
    const s = setup();
    await s.adapter.load(ytTrack);

    s.players[0]!.duration = 214;
    vi.advanceTimersByTime(200);
    expect(s.adapter.getDurationMs()).toBe(214_000);
  });

  it('survives SDK throws inside the poll callback (post-destroy race)', async () => {
    const s = setup();
    await s.adapter.load(ytTrack);

    s.players[0]!.getCurrentTime = (): number => {
      throw new Error('player gone');
    };
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
  });
});

describe('YouTubeAdapter — unload', () => {
  it('destroys the player and clears listeners', async () => {
    const { adapter, players } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('ended', cb);

    await adapter.unload();
    expect(players[0]!.destroyCount).toBe(1);

    // Subsequent state-change events should not reach the (cleared)
    // listener set.
    players[0]!.fireEnded();
    expect(cb).not.toHaveBeenCalled();

    await expect(adapter.play()).rejects.toThrow(/before load/);
  });

  it('stops the poll interval (no more timeupdates after unload)', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const cb = vi.fn();
      s.adapter.on('timeupdate', cb);

      // onReady resolves via microtask, not a faked timer — see
      // the comment in the "timeupdate polling" suite.
      await s.adapter.load(ytTrack);

      s.players[0]!.currentTime = 1;
      vi.advanceTimersByTime(200);
      const callsAfterFirstTick = cb.mock.calls.length;
      expect(callsAfterFirstTick).toBeGreaterThan(0);

      await s.adapter.unload();
      s.players[0]!.currentTime = 2;
      vi.advanceTimersByTime(2_000);
      expect(cb.mock.calls.length).toBe(callsAfterFirstTick);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op if called before any load', async () => {
    const { adapter } = setup();
    await expect(adapter.unload()).resolves.toBeUndefined();
  });

  it('swallows destroy() throws and still completes unload', async () => {
    const { adapter, players } = await setupLoaded();
    players[0]!.destroyShouldThrow = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(adapter.unload()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('YouTubeAdapter — getVisualElement', () => {
  it('returns null before load', () => {
    const { adapter } = setup();
    expect(adapter.getVisualElement()).toBeNull();
  });

  it('returns the mount element after load', async () => {
    const { adapter } = await setupLoaded();
    expect(adapter.getVisualElement()).not.toBeNull();
  });

  it('returns null after unload', async () => {
    const { adapter } = await setupLoaded();
    await adapter.unload();
    expect(adapter.getVisualElement()).toBeNull();
  });
});

describe('YouTubeAdapter — getPositionMs / getDurationMs', () => {
  it('both return 0 before load', () => {
    const { adapter } = setup();
    expect(adapter.getPositionMs()).toBe(0);
    expect(adapter.getDurationMs()).toBe(0);
  });

  it('getDurationMs reflects the initial getDuration after load', async () => {
    const { adapter, players } = await setupLoaded();
    players[0]!.duration = 100;
    // The initial sample happened in onReady. Force one poll tick to
    // re-sample (real timer; default duration=60 was captured at ready).
    expect(adapter.getDurationMs()).toBe(60_000);
  });
});
