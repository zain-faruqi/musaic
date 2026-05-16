import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedTrack } from '@renderer/core/types';
import {
  SpotifyAdapter,
  classifyPlaybackErrorMessage,
} from './spotify-adapter';
import type { SpotifyUnplayableError } from './spotify-adapter';
import { __resetSharedForTests } from './shared-player';
import type {
  SpotifyGlobal,
  SpotifyPlayer,
  SpotifyPlayerState,
} from './types';

/**
 * Tests for the SpotifyAdapter under the singleton-facade model.
 *
 * The Spotify Web Playback SDK doesn't cleanly support multiple
 * `Spotify.Player` instances per renderer process — adapter
 * instances now share a module-level singleton (see
 * `shared-player.ts`). Each test resets the singleton in
 * beforeEach so state doesn't leak across tests.
 *
 * The mock SDK exposes a single `Spotify.Player` constructor whose
 * `addListener` captures handlers by event name. The harness fires
 * events back through the captured handlers — the singleton's
 * fan-out then dispatches to whatever adapter subscribers are
 * currently registered.
 */

const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';
const URI = `spotify:track:${TRACK_ID}`;

const TRACK: UnifiedTrack = {
  id: `spotify:${TRACK_ID}`,
  source: 'spotify',
  sourceId: URI,
  title: 'Blinding Lights',
  artists: ['The Weeknd'],
  durationMs: 200_040,
};

const TRACK_ID_2 = '4iV5W9uYEdYUVa79Axb7Rh';
const URI_2 = `spotify:track:${TRACK_ID_2}`;
const TRACK_2: UnifiedTrack = {
  id: `spotify:${TRACK_ID_2}`,
  source: 'spotify',
  sourceId: URI_2,
  title: 'Different Track',
  artists: ['Other Artist'],
  durationMs: 180_000,
};

type Listeners = {
  ready: Array<(e: { device_id: string }) => void>;
  not_ready: Array<(e: { device_id: string }) => void>;
  player_state_changed: Array<(s: SpotifyPlayerState | null) => void>;
  initialization_error: Array<(e: { message: string }) => void>;
  authentication_error: Array<(e: { message: string }) => void>;
  account_error: Array<(e: { message: string }) => void>;
  playback_error: Array<(e: { message: string }) => void>;
};

function makeMockSdk() {
  const listeners: Listeners = {
    ready: [],
    not_ready: [],
    player_state_changed: [],
    initialization_error: [],
    authentication_error: [],
    account_error: [],
    playback_error: [],
  };

  const player: SpotifyPlayer & {
    _calls: {
      connect: number;
      activate: number;
      pause: number;
      resume: number;
      seek: number[];
      setVolume: number[];
      disconnect: number;
    };
  } = {
    _calls: {
      connect: 0,
      activate: 0,
      pause: 0,
      resume: 0,
      seek: [],
      setVolume: [],
      disconnect: 0,
    },
    connect: vi.fn(async () => {
      player._calls.connect++;
      return true;
    }),
    disconnect: vi.fn(() => {
      player._calls.disconnect++;
    }),
    pause: vi.fn(async () => {
      player._calls.pause++;
    }),
    resume: vi.fn(async () => {
      player._calls.resume++;
    }),
    togglePlay: vi.fn(),
    seek: vi.fn(async (ms: number) => {
      player._calls.seek.push(ms);
    }),
    setVolume: vi.fn(async (v: number) => {
      player._calls.setVolume.push(v);
    }),
    getCurrentState: vi.fn(async () => null),
    activateElement: vi.fn(async () => {
      player._calls.activate++;
    }),
    addListener: ((event: string, cb: unknown): boolean => {
      const key = event as keyof Listeners;
      (listeners[key] as Array<unknown>).push(cb);
      return true;
    }) as SpotifyPlayer['addListener'],
    removeListener: vi.fn((event: keyof Listeners) => {
      listeners[event].length = 0;
      return true;
    }),
  };

  let constructorCalls = 0;
  let lastConfig: ConstructorParameters<SpotifyGlobal['Player']>[0] | null = null;
  const sdk: SpotifyGlobal = {
    Player: function (
      this: unknown,
      config: ConstructorParameters<SpotifyGlobal['Player']>[0],
    ) {
      constructorCalls++;
      lastConfig = config;
      return player;
    } as unknown as SpotifyGlobal['Player'],
  };

  const harness = {
    fireReady(deviceId = 'device-abc') {
      for (const cb of listeners.ready) cb({ device_id: deviceId });
    },
    fireStateChange(state: Partial<SpotifyPlayerState>) {
      const full: SpotifyPlayerState = {
        position: 0,
        duration: TRACK.durationMs,
        paused: true,
        loading: false,
        track_window: {
          current_track: { uri: URI, id: TRACK_ID },
        },
        ...state,
      };
      for (const cb of listeners.player_state_changed) cb(full);
    },
    fireError(
      kind:
        | 'initialization_error'
        | 'authentication_error'
        | 'account_error'
        | 'playback_error',
      message: string,
    ) {
      for (const cb of listeners[kind]) cb({ message });
    },
    constructorCalls: () => constructorCalls,
    lastConfig: () => lastConfig,
    player,
  };

  return { sdk, harness };
}

/**
 * Build an adapter + injected seams. Tests drive the clock via
 * Date.now-spy + scheduler injection (vi.useFakeTimers wouldn't
 * help because the adapter uses real Date.now() for position
 * interpolation).
 */
function makeAdapter() {
  __resetSharedForTests();

  const { sdk, harness } = makeMockSdk();

  let nowMs = 1_000_000;
  const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  const advanceTime = (ms: number) => {
    nowMs += ms;
  };

  let timerFn: (() => void) | null = null;
  let timerInterval = 0;
  const setIntervalImpl = (fn: () => void, ms: number) => {
    timerFn = fn;
    timerInterval = ms;
    return 1 as unknown as ReturnType<typeof setInterval>;
  };
  const clearIntervalImpl = () => {
    timerFn = null;
    timerInterval = 0;
  };

  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () => new Response(null, { status: 204 }),
  );

  const getAccessToken = vi.fn(async () => 'fake-access-token');

  const makeOne = () =>
    new SpotifyAdapter({
      loadSdk: async () => sdk,
      getAccessToken,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      setIntervalImpl,
      clearIntervalImpl,
    });

  return {
    adapter: makeOne(),
    makeAdapter: makeOne,
    sdk,
    harness,
    fetchImpl,
    getAccessToken,
    advanceTime,
    tickPoll: () => timerFn?.(),
    pollInterval: () => timerInterval,
    isPolling: () => timerFn !== null,
    teardown: () => dateNowSpy.mockRestore(),
  };
}

/**
 * Resolve the singleton during a load() call. The singleton's
 * construction sequence: SDK load → construct → connect → wait for
 * `ready` → activateElement → ready. Tests fire the `ready` event
 * once the load promise has had a chance to register its listener.
 */
async function resolveSingletonViaLoad(
  loadPromise: Promise<unknown>,
  harness: ReturnType<typeof makeMockSdk>['harness'],
): Promise<void> {
  // Yield enough microtasks for connect() to resolve and the
  // ready listener to be registered.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  harness.fireReady();
  await loadPromise;
}

/**
 * Drive a play() through the happy path: PUT 204 returns, then the
 * URI-loaded state event fires.
 */
async function drivePlay(
  playPromise: Promise<unknown>,
  harness: ReturnType<typeof makeMockSdk>['harness'],
  uri = URI,
): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  harness.fireStateChange({
    position: 0,
    paused: false,
    loading: false,
    track_window: { current_track: { uri, id: uri.split(':').pop()! } },
  });
  await playPromise;
}

beforeEach(() => {
  __resetSharedForTests();
});

// ---------- classifyPlaybackErrorMessage ----------

describe('classifyPlaybackErrorMessage', () => {
  it('returns premium-required for "Premium account required"', () => {
    expect(classifyPlaybackErrorMessage('Premium account required')).toBe(
      'premium-required',
    );
  });

  it('returns premium-required for case-insensitive premium', () => {
    expect(classifyPlaybackErrorMessage('PREMIUM ONLY')).toBe(
      'premium-required',
    );
  });

  it('returns region-locked for region-restricted messages', () => {
    expect(
      classifyPlaybackErrorMessage('Content not available in this region'),
    ).toBe('region-locked');
  });

  it('returns content-removed for "removed"', () => {
    expect(
      classifyPlaybackErrorMessage('Track has been removed from Spotify'),
    ).toBe('content-removed');
  });

  it('returns content-removed for "unavailable"', () => {
    expect(
      classifyPlaybackErrorMessage('This content is currently unavailable'),
    ).toBe('content-removed');
  });

  it('returns content-removed for "no longer"', () => {
    expect(classifyPlaybackErrorMessage('Track is no longer available')).toBe(
      'content-removed',
    );
  });

  it('returns unknown for unrecognized messages', () => {
    expect(classifyPlaybackErrorMessage('Some other failure')).toBe('unknown');
  });

  it('returns unknown for empty messages', () => {
    expect(classifyPlaybackErrorMessage('')).toBe('unknown');
  });

  it('prefers premium-required over region when both keywords present', () => {
    expect(
      classifyPlaybackErrorMessage('Premium required for this region'),
    ).toBe('premium-required');
  });
});

// ---------- SpotifyAdapter — basic shape ----------

describe('SpotifyAdapter — basic shape', () => {
  it('reports source = spotify', () => {
    const { adapter, teardown } = makeAdapter();
    expect(adapter.source).toBe('spotify');
    teardown();
  });

  it('rejects non-spotify tracks', async () => {
    const { adapter, teardown } = makeAdapter();
    const local: UnifiedTrack = {
      id: 'x',
      source: 'local',
      sourceId: '/x.mp3',
      title: 't',
      artists: [],
      durationMs: 1,
    };
    await expect(adapter.load(local)).rejects.toThrow(
      /cannot load track from source 'local'/,
    );
    teardown();
  });

  it('throws on play/pause/seek/setVolume before load', async () => {
    const { adapter, teardown } = makeAdapter();
    await expect(adapter.play()).rejects.toThrow(/before load/);
    await expect(adapter.pause()).rejects.toThrow(/before load/);
    await expect(adapter.seek(0)).rejects.toThrow(/before load/);
    await expect(adapter.setVolume(0.5)).rejects.toThrow(/before load/);
    teardown();
  });

  it('returns null from getVisualElement (audio-only)', () => {
    const { adapter, teardown } = makeAdapter();
    expect(adapter.getVisualElement()).toBe(null);
    teardown();
  });

  it('returns 0 from getDurationMs/getPositionMs before any state event', () => {
    const { adapter, teardown } = makeAdapter();
    expect(adapter.getDurationMs()).toBe(0);
    expect(adapter.getPositionMs()).toBe(0);
    teardown();
  });
});

// ---------- SpotifyAdapter — load resolves the singleton ----------

describe('SpotifyAdapter — load', () => {
  it('resolves the shared singleton and wires subscribers', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    const loadPromise = adapter.load(TRACK);
    await resolveSingletonViaLoad(loadPromise, harness);

    // Player constructed once with our config.
    expect(harness.constructorCalls()).toBe(1);
    const cfg = harness.lastConfig();
    expect(cfg?.name).toBe('Musaic');

    // Singleton went through its construction dance.
    expect(harness.player._calls.connect).toBe(1);
    expect(harness.player._calls.activate).toBe(1);

    // load() should NOT have made any HTTP calls.
    // PUT play happens at play() time in the singleton model.
    teardown();
  });

  it('does not issue PUT /me/player/play during load', async () => {
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    const loadPromise = adapter.load(TRACK);
    await resolveSingletonViaLoad(loadPromise, harness);
    expect(fetchImpl).not.toHaveBeenCalled();
    teardown();
  });

  it('reuses the singleton for a second adapter instance', async () => {
    const { adapter, makeAdapter: makeAnother, harness, teardown } = makeAdapter();
    const load1 = adapter.load(TRACK);
    await resolveSingletonViaLoad(load1, harness);
    expect(harness.constructorCalls()).toBe(1);

    // Second adapter — should NOT construct a second Spotify.Player.
    // It should reuse the singleton.
    const adapter2 = makeAnother();
    const load2 = adapter2.load(TRACK_2);
    // No need to fire ready again — singleton is already resolved.
    await load2;
    expect(harness.constructorCalls()).toBe(1);
    teardown();
  });
});

// ---------- SpotifyAdapter — play happy path ----------

describe('SpotifyAdapter — play', () => {
  it('issues PUT /me/player/play with the loaded track URI', async () => {
    const { adapter, harness, fetchImpl, getAccessToken, teardown } =
      makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);

    const playPromise = adapter.play();
    await drivePlay(playPromise, harness);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toMatch(
      /api\.spotify\.com\/v1\/me\/player\/play\?device_id=device-abc/,
    );
    expect((init as RequestInit | undefined)?.method).toBe('PUT');
    expect((init as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ uris: [URI] }),
    );
    expect(getAccessToken).toHaveBeenCalled();
    teardown();
  });

  it('captures duration from the state event after play', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    expect(adapter.getDurationMs()).toBe(TRACK.durationMs);
    teardown();
  });

  it('starts the poll loop after play', async () => {
    const { adapter, harness, isPolling, pollInterval, teardown } =
      makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    expect(isPolling()).toBe(true);
    expect(pollInterval()).toBe(250);
    teardown();
  });

  it('resume-vs-replay: same URI paused → resume() not PUT play', async () => {
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    expect(harness.player._calls.resume).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Pause: state event reflects paused=true for our URI.
    harness.fireStateChange({
      position: 5000,
      paused: true,
      duration: TRACK.durationMs,
      track_window: { current_track: { uri: URI, id: TRACK_ID } },
    });

    // play() now should resume, not PUT play again.
    await adapter.play();
    expect(harness.player._calls.resume).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Still just the one PUT.
    teardown();
  });
});

// ---------- Sequential plays (the smoke-test bug case) ----------

describe('SpotifyAdapter — sequential plays across instances', () => {
  it('a second adapter can play through the same singleton', async () => {
    const {
      adapter,
      makeAdapter: makeAnother,
      harness,
      fetchImpl,
      teardown,
    } = makeAdapter();

    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    await adapter.unload();

    // The OLD model would have called disconnect() here. The new
    // model leaves the singleton alive.
    expect(harness.player._calls.disconnect).toBe(0);

    // Second adapter, second track.
    const adapter2 = makeAnother();
    await adapter2.load(TRACK_2);

    // Confirm no second Spotify.Player was constructed.
    expect(harness.constructorCalls()).toBe(1);

    const playPromise2 = adapter2.play();
    await drivePlay(playPromise2, harness, URI_2);

    // Second PUT went out, against the same device_id.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init2] = fetchImpl.mock.calls[1]!;
    expect((init2 as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ uris: [URI_2] }),
    );
    teardown();
  });

  it('unload removes subscribers without disconnecting the singleton', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const errCb = vi.fn();
    adapter.on('error', errCb);
    await adapter.unload();

    // After unload, the adapter's listeners are gone. Firing a SDK
    // error should not invoke them.
    harness.fireError('playback_error', 'something happened');
    expect(errCb).not.toHaveBeenCalled();

    // And the singleton's player was NOT disconnected.
    expect(harness.player._calls.disconnect).toBe(0);
    teardown();
  });
});

// ---------- SpotifyAdapter — play error paths ----------

describe('SpotifyAdapter — play error paths', () => {
  it('surfaces SpotifyUnplayableError on PUT 401', async () => {
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);

    fetchImpl.mockImplementationOnce(
      async () => new Response('Token expired', { status: 401 }),
    );

    await expect(adapter.play()).rejects.toMatchObject({
      reason: 'auth-required',
      watchUrl: `https://open.spotify.com/track/${TRACK_ID}`,
    });
    teardown();
  });

  it('surfaces premium-required on PUT 403 with generic body', async () => {
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);

    fetchImpl.mockImplementationOnce(
      async () => new Response('Forbidden', { status: 403 }),
    );
    await expect(adapter.play()).rejects.toMatchObject({
      reason: 'premium-required',
    });
    teardown();
  });

  it('classifies 403 body when body has a known reason', async () => {
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);

    fetchImpl.mockImplementationOnce(
      async () =>
        new Response('Content is no longer available', { status: 403 }),
    );
    await expect(adapter.play()).rejects.toMatchObject({
      reason: 'content-removed',
    });
    teardown();
  });

  it('PUT 404 "Device not found" maps to auth-required (not content-removed)', async () => {
    // This is the substantive smoke bug: pre-singleton, the user's
    // second click produced "Device not found" and the classifier
    // mapped it to content-removed (wrong copy: "this track has been
    // removed from Spotify"). The singleton fix prevents this from
    // happening in normal operation, but if it ever slips, the
    // classifier should report it as auth-required (user re-engages).
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);

    fetchImpl.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: { status: 404, message: 'Device not found' },
          }),
          { status: 404 },
        ),
    );
    await expect(adapter.play()).rejects.toMatchObject({
      reason: 'auth-required',
    });
    teardown();
  });

  it('PUT 404 with other body maps to content-removed', async () => {
    const { adapter, harness, fetchImpl, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);

    fetchImpl.mockImplementationOnce(
      async () => new Response('Track not found', { status: 404 }),
    );
    await expect(adapter.play()).rejects.toMatchObject({
      reason: 'content-removed',
    });
    teardown();
  });

  it('surfaces auth-required when no token is available for PUT', async () => {
    __resetSharedForTests();
    const { sdk, harness } = makeMockSdk();
    const adapter = new SpotifyAdapter({
      loadSdk: async () => sdk,
      getAccessToken: async () => null,
      fetchImpl: vi.fn() as unknown as typeof globalThis.fetch,
      setIntervalImpl: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearIntervalImpl: () => {},
    });

    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await expect(adapter.play()).rejects.toMatchObject({
      reason: 'auth-required',
    });
  });
});

// ---------- SDK error events fan out to the right adapter ----------

describe('SpotifyAdapter — SDK error events', () => {
  it('forwards authentication_error to error listeners with reason=auth-required', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const errCb = vi.fn();
    adapter.on('error', errCb);
    harness.fireError('authentication_error', 'token expired');
    expect(errCb).toHaveBeenCalledTimes(1);
    const err = errCb.mock.calls[0]![0] as SpotifyUnplayableError;
    expect(err.reason).toBe('auth-required');
    expect(err.watchUrl).toBe(`https://open.spotify.com/track/${TRACK_ID}`);
    teardown();
  });

  it('forwards account_error to error listeners with reason=premium-required', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    const errCb = vi.fn();
    adapter.on('error', errCb);
    harness.fireError('account_error', 'account is not premium');
    expect((errCb.mock.calls[0]![0] as SpotifyUnplayableError).reason).toBe(
      'premium-required',
    );
    teardown();
  });

  it('classifies playback_error messages via classifyPlaybackErrorMessage', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    const errCb = vi.fn();
    adapter.on('error', errCb);
    harness.fireError('playback_error', 'Content not available in this region');
    expect((errCb.mock.calls[0]![0] as SpotifyUnplayableError).reason).toBe(
      'region-locked',
    );
    teardown();
  });

  it('forwards initialization_error with reason=unknown', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    const errCb = vi.fn();
    adapter.on('error', errCb);
    harness.fireError('initialization_error', 'failed to initialize');
    expect((errCb.mock.calls[0]![0] as SpotifyUnplayableError).reason).toBe(
      'unknown',
    );
    teardown();
  });

  it('does NOT forward an error to adapter A when adapter B is current', async () => {
    // Two adapters loaded against the same singleton. Adapter A's
    // track is no longer current (B's state was the latest); an
    // error from the SDK should fire only on adapter B's listeners.
    const {
      adapter: adapterA,
      makeAdapter: makeAnother,
      harness,
      teardown,
    } = makeAdapter();
    await resolveSingletonViaLoad(adapterA.load(TRACK), harness);
    await drivePlay(adapterA.play(), harness);

    const adapterB = makeAnother();
    await adapterB.load(TRACK_2);
    await drivePlay(adapterB.play(), harness, URI_2);

    const errA = vi.fn();
    const errB = vi.fn();
    adapterA.on('error', errA);
    adapterB.on('error', errB);

    harness.fireError('playback_error', 'something happened');
    expect(errA).not.toHaveBeenCalled();
    expect(errB).toHaveBeenCalledTimes(1);
    teardown();
  });
});

// ---------- Playback state ----------

describe('SpotifyAdapter — playback state', () => {
  it('pause() resolves through SDK.pause', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    const before = harness.player._calls.pause;
    await adapter.pause();
    expect(harness.player._calls.pause).toBe(before + 1);
    teardown();
  });

  it('seek clamps and forwards to SDK.seek', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    await adapter.seek(50_000);
    expect(harness.player._calls.seek).toContain(50_000);
    await adapter.seek(TRACK.durationMs + 5);
    expect(harness.player._calls.seek).toContain(TRACK.durationMs);
    teardown();
  });

  it('setVolume clamps to 0..1 and forwards to SDK.setVolume', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    await adapter.setVolume(0.5);
    await adapter.setVolume(1.5);
    await adapter.setVolume(-0.3);
    expect(harness.player._calls.setVolume).toEqual([0.5, 1, 0]);
    teardown();
  });

  it('emits timeupdate from the poll loop using interpolated position', async () => {
    const { adapter, harness, advanceTime, tickPoll, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const cb = vi.fn();
    adapter.on('timeupdate', cb);

    harness.fireStateChange({
      position: 1000,
      paused: false,
      duration: TRACK.durationMs,
    });

    advanceTime(300);
    tickPoll();
    expect(cb).toHaveBeenLastCalledWith(1300);

    advanceTime(250);
    tickPoll();
    expect(cb).toHaveBeenLastCalledWith(1550);
    teardown();
  });

  it('freezes position interpolation when paused', async () => {
    const { adapter, harness, advanceTime, tickPoll, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    harness.fireStateChange({
      position: 2000,
      paused: true,
      duration: TRACK.durationMs,
    });

    advanceTime(5000);
    const cb = vi.fn();
    adapter.on('timeupdate', cb);
    tickPoll();
    expect(cb).toHaveBeenLastCalledWith(2000);
    teardown();
  });

  it('fires ended once when state reports paused at duration', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const endedCb = vi.fn();
    adapter.on('ended', endedCb);

    harness.fireStateChange({
      position: TRACK.durationMs,
      paused: true,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).toHaveBeenCalledTimes(1);

    harness.fireStateChange({
      position: TRACK.durationMs,
      paused: true,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('does not fire ended when paused at 0 during initial buffering', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const endedCb = vi.fn();
    adapter.on('ended', endedCb);

    harness.fireStateChange({
      position: 0,
      paused: true,
      duration: 0,
      loading: true,
    });
    expect(endedCb).not.toHaveBeenCalled();
    teardown();
  });

  // ---- Natural-end detection -----------------------------------
  //
  // Spotify Web Playback SDK fires `paused: true, position: 0` on
  // natural track end (auto-reset), never `position >= duration`.
  // The pre-correction detector was `position >= duration` and missed
  // every natural end; the corrected detector watches for the
  // near-end-then-reset signature on `#lastState`.

  it('fires ended on natural end (near-duration then paused-at-zero)', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const endedCb = vi.fn();
    adapter.on('ended', endedCb);

    // Track approaches end (position within 3000ms of duration).
    harness.fireStateChange({
      position: TRACK.durationMs - 500,
      paused: false,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).not.toHaveBeenCalled();

    // SDK fires `paused: true, position: 0` on natural end (auto-reset).
    harness.fireStateChange({
      position: 0,
      paused: true,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).toHaveBeenCalledTimes(1);

    // Subsequent paused-at-0 states don't re-fire (once-only guard).
    harness.fireStateChange({
      position: 0,
      paused: true,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).toHaveBeenCalledTimes(1);
    teardown();
  });

  it(
    'fires ended on natural end even when the SDK emits no intermediate state events ' +
      '(prior.position is stale; interpolation drives the detection)',
    async () => {
      // This is the scenario an earlier detection pass missed
      // in packaged build. Spotify's SDK does not emit a
      // `player_state_changed` every position tick — there can be
      // minutes between state events during steady playback. So at
      // the moment the natural-end state arrives, the prior state's
      // raw `.position` field may still be ≈0 (the value when the
      // track started playing). A detector that compares
      // `prior.duration - prior.position` against a 3000ms window
      // sees ~full-duration and bails. The corrected detector uses
      // the *interpolated* prior position (Date.now() against
      // #lastStateTime), which correctly reports "we'd be near
      // duration right now."
      const { adapter, harness, advanceTime, teardown } = makeAdapter();
      await resolveSingletonViaLoad(adapter.load(TRACK), harness);
      await drivePlay(adapter.play(), harness);
      // drivePlay's fireStateChange landed at position 0, paused
      // false — so this.#lastState is "started playing." No further
      // state events for the duration of the track.

      const endedCb = vi.fn();
      adapter.on('ended', endedCb);

      // Simulate the full duration of the track elapsing. The Date.now
      // spy in makeAdapter advances on advanceTime() calls; the adapter
      // uses it for interpolation.
      advanceTime(TRACK.durationMs);

      // SDK fires the natural-end state. prior.position is still 0
      // (no intermediate state events), but interpolated position is
      // ≈duration.
      harness.fireStateChange({
        position: 0,
        paused: true,
        duration: TRACK.durationMs,
        loading: false,
      });
      expect(endedCb).toHaveBeenCalledTimes(1);
      teardown();
    },
  );

  it(
    'fires ended via the poll-based fallback when the SDK emits no usable ended state',
    async () => {
      // Belt-and-braces for the case the SDK doesn't even emit a
      // recognizable natural-end state event. The polling loop is
      // already running for timeupdate; piggyback on it. When the
      // interpolated position has reached duration and the SDK
      // still claims we're playing (#lastState.paused === false),
      // treat the timer crossing as the ended signal.
      const { adapter, harness, advanceTime, tickPoll, teardown } = makeAdapter();
      await resolveSingletonViaLoad(adapter.load(TRACK), harness);
      await drivePlay(adapter.play(), harness);

      const endedCb = vi.fn();
      adapter.on('ended', endedCb);

      // Simulate the full duration of the track playing without any
      // intermediate state events. (No natural-end state arrives at
      // all — pure poll-based detection.)
      advanceTime(TRACK.durationMs);
      tickPoll();

      expect(endedCb).toHaveBeenCalledTimes(1);

      // Subsequent ticks don't re-fire.
      tickPoll();
      expect(endedCb).toHaveBeenCalledTimes(1);
      teardown();
    },
  );

  it(
    'fires ended on natural end when SDK clears current_track (multi-shape detector)',
    async () => {
      // The natural-end bug in packaged Spotify: after a track
      // ends naturally, the real SDK can fire a state event in which
      // `track_window.current_track.uri` is no longer our URI (Spotify
      // unloaded our track on the device side before firing the
      // position-reset event we expect). The iter-3 detector bailed at
      // the URI mismatch check and never ran the natural-end logic.
      // iter-4's multi-shape detector treats URI-mismatch as one of
      // the valid natural-end signal shapes provided the prior state
      // had us playing within the near-end window.
      const { adapter, harness, advanceTime, teardown } = makeAdapter();
      await resolveSingletonViaLoad(adapter.load(TRACK), harness);
      await drivePlay(adapter.play(), harness);

      const endedCb = vi.fn();
      adapter.on('ended', endedCb);

      // Track plays to end without intermediate state events.
      advanceTime(TRACK.durationMs);

      // SDK fires a state with current_track.uri set to something
      // else — our slot has been cleared. observedPriorPosition is
      // near duration (interpolation), prior was playing, so this
      // should fire ended.
      harness.fireStateChange({
        position: 0,
        paused: false,
        duration: TRACK.durationMs,
        loading: false,
        track_window: {
          current_track: { uri: 'spotify:track:DIFFERENT', id: 'other' },
        },
      });
      expect(endedCb).toHaveBeenCalledTimes(1);
      teardown();
    },
  );

  it(
    'fires ended on natural end when SDK zeroes duration (multi-shape detector)',
    async () => {
      // Another packaged-Spotify shape: the SDK fires a state where
      // current_track still matches but `duration` is 0 — the track
      // has been unloaded so its metadata is gone but the slot
      // identifier hasn't been replaced yet. The iter-3 detector
      // bailed at `if (state.duration <= 0) return` BEFORE the
      // natural-end check ran. iter-4's multi-shape detector treats
      // duration-zero on our track as a natural-end signal provided
      // the prior was near end.
      const { adapter, harness, advanceTime, teardown } = makeAdapter();
      await resolveSingletonViaLoad(adapter.load(TRACK), harness);
      await drivePlay(adapter.play(), harness);

      const endedCb = vi.fn();
      adapter.on('ended', endedCb);

      // Track plays to end.
      advanceTime(TRACK.durationMs);

      // SDK fires our-track with duration zeroed. Position can be 0
      // or anything else; duration=0 is the signal.
      harness.fireStateChange({
        position: 0,
        paused: true,
        duration: 0,
        loading: false,
      });
      expect(endedCb).toHaveBeenCalledTimes(1);
      teardown();
    },
  );

  it(
    'does NOT fire ended when current_track changes but prior was not near end',
    async () => {
      // Defensive: the URI-mismatch branch of the multi-shape detector
      // requires `priorLookedNearEnd`. If the SDK changes our slot
      // away from us mid-track (some external Spotify-client action,
      // e.g. the user pressed Next on their phone), we should NOT
      // interpret that as our track's natural end — the prior wasn't
      // near duration, just somewhere mid-playback.
      const { adapter, harness, advanceTime, teardown } = makeAdapter();
      await resolveSingletonViaLoad(adapter.load(TRACK), harness);
      await drivePlay(adapter.play(), harness);

      const endedCb = vi.fn();
      adapter.on('ended', endedCb);

      // Advance to mid-track (well outside the near-end window).
      advanceTime(Math.floor(TRACK.durationMs / 3));

      // External force-change of current_track.
      harness.fireStateChange({
        position: 0,
        paused: false,
        duration: TRACK.durationMs,
        loading: false,
        track_window: {
          current_track: { uri: 'spotify:track:DIFFERENT', id: 'other' },
        },
      });
      expect(endedCb).not.toHaveBeenCalled();
      teardown();
    },
  );

  it('does not fire ended on mid-track pause', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    const endedCb = vi.fn();
    adapter.on('ended', endedCb);

    // Pause mid-track. Position is nowhere near duration; the natural-
    // end detector should ignore this entirely.
    harness.fireStateChange({
      position: Math.floor(TRACK.durationMs / 2),
      paused: true,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).not.toHaveBeenCalled();

    // Resume.
    harness.fireStateChange({
      position: Math.floor(TRACK.durationMs / 2),
      paused: false,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedCb).not.toHaveBeenCalled();
    teardown();
  });

  it('fires ended on natural end across sequential tracks (A then B)', async () => {
    // The `#endedFired` flag resets on load(), so a fresh adapter
    // instance loading track B after track A ended should fire its
    // own ended event when B reaches natural end. This is the
    // playlist-import flow the bug surfaced in.
    const harness = makeAdapter();
    const { adapter: adapterA, harness: h, makeAdapter: makeOne, teardown } = harness;

    // ---- Track A: load, play, drive natural end ----
    await resolveSingletonViaLoad(adapterA.load(TRACK), h);
    await drivePlay(adapterA.play(), h);
    const endedA = vi.fn();
    adapterA.on('ended', endedA);

    h.fireStateChange({
      position: TRACK.durationMs - 500,
      paused: false,
      duration: TRACK.durationMs,
      loading: false,
    });
    h.fireStateChange({
      position: 0,
      paused: true,
      duration: TRACK.durationMs,
      loading: false,
    });
    expect(endedA).toHaveBeenCalledTimes(1);

    // ---- Track B: fresh adapter instance via the singleton ----
    await adapterA.unload();
    const adapterB = makeOne();
    await resolveSingletonViaLoad(adapterB.load(TRACK_2), h);
    await drivePlay(adapterB.play(), h, URI_2);
    const endedB = vi.fn();
    adapterB.on('ended', endedB);

    h.fireStateChange({
      position: TRACK_2.durationMs - 500,
      paused: false,
      duration: TRACK_2.durationMs,
      loading: false,
      track_window: { current_track: { uri: URI_2, id: TRACK_ID_2 } },
    });
    h.fireStateChange({
      position: 0,
      paused: true,
      duration: TRACK_2.durationMs,
      loading: false,
      track_window: { current_track: { uri: URI_2, id: TRACK_ID_2 } },
    });
    expect(endedB).toHaveBeenCalledTimes(1);
    teardown();
  });
});

// ---------- Unload semantics ----------

describe('SpotifyAdapter — unload', () => {
  it('does not disconnect the singleton player', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    await adapter.unload();
    expect(harness.player._calls.disconnect).toBe(0);
    teardown();
  });

  it('stops the poll loop on unload', async () => {
    const { adapter, harness, isPolling, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    expect(isPolling()).toBe(true);
    await adapter.unload();
    expect(isPolling()).toBe(false);
    teardown();
  });

  it('unload is idempotent', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);
    await adapter.unload();
    await expect(adapter.unload()).resolves.toBeUndefined();
    teardown();
  });

  // The cross-source handoff bug: a Spotify track keeps playing in
  // the background when the user clicks a local/youtube track.
  // setQueue → #disposeAll → spotify-adapter.unload() runs BEFORE
  // the next adapter loads, so unload is responsible for silencing
  // the singleton. The pre-singleton model got this for free via
  // `disconnect()`; the singleton model needs an explicit pause.

  it('unload pauses the singleton when our URI is currently playing', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    // Singleton's latestState now reflects our URI, playing.
    const pauseBefore = harness.player._calls.pause;
    await adapter.unload();
    expect(harness.player._calls.pause).toBe(pauseBefore + 1);
    teardown();
  });

  it('unload does NOT pause when another adapter has taken over', async () => {
    // Spotify-to-Spotify handoff: adapter B's play() has already
    // swapped the device's URI to B's. When PlayerManager unloads
    // adapter A, the singleton's current URI is B's, not A's.
    // Unloading A must NOT pause B's playback.
    const {
      adapter: adapterA,
      makeAdapter: makeAnother,
      harness,
      teardown,
    } = makeAdapter();
    await resolveSingletonViaLoad(adapterA.load(TRACK), harness);
    await drivePlay(adapterA.play(), harness);

    const adapterB = makeAnother();
    await adapterB.load(TRACK_2);
    await drivePlay(adapterB.play(), harness, URI_2);
    // Singleton.latestState.current now reflects URI_2, playing.

    const pauseBefore = harness.player._calls.pause;
    await adapterA.unload();
    expect(harness.player._calls.pause).toBe(pauseBefore);
    teardown();
  });

  it('unload does NOT redundantly pause when already paused', async () => {
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    await drivePlay(adapter.play(), harness);

    // Singleton transitions to paused (user clicked pause earlier).
    harness.fireStateChange({
      position: 5000,
      paused: true,
      duration: TRACK.durationMs,
      track_window: { current_track: { uri: URI, id: TRACK_ID } },
    });

    const pauseBefore = harness.player._calls.pause;
    await adapter.unload();
    expect(harness.player._calls.pause).toBe(pauseBefore);
    teardown();
  });

  it('unload skips the pause when no state event has been seen', async () => {
    // Edge case: load + immediate unload without ever calling play
    // (or play threw before state arrived). latestState.current is
    // null; we can't know whether the singleton is playing our URI,
    // so skip best-effort. The next adapter's play() swaps URIs
    // anyway, so worst case is a few hundred ms of audio leakage —
    // acceptable for this rare path.
    const { adapter, harness, teardown } = makeAdapter();
    await resolveSingletonViaLoad(adapter.load(TRACK), harness);
    // No drivePlay — singleton's latestState.current stays null.

    const pauseBefore = harness.player._calls.pause;
    await adapter.unload();
    expect(harness.player._calls.pause).toBe(pauseBefore);
    teardown();
  });
});
