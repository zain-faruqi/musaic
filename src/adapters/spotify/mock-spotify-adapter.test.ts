import { describe, expect, it, vi } from 'vitest';
import type { UnifiedTrack } from '@renderer/core/types';
import { MockSpotifyAdapter } from './mock-spotify-adapter';

/**
 * Tests for MockSpotifyAdapter. Production wires `setInterval` /
 * `clearInterval`; the tests inject controllable replacements so we
 * can step the timer deterministically and verify state transitions
 * without flaky timing.
 *
 * The internal `#tick()` uses `Date.now()` deltas — the test helpers
 * mock that too via `vi.useFakeTimers()` so position advances by a
 * predictable amount per fake tick.
 */

const TRACK: UnifiedTrack = {
  id: 'spotify:0VjIjW4GlUZAMYd2vXMi3b',
  source: 'spotify',
  sourceId: '0VjIjW4GlUZAMYd2vXMi3b',
  title: 'Blinding Lights',
  artists: ['The Weeknd'],
  durationMs: 5_000, // short so ended-fires tests are quick
};

/**
 * Build an adapter + controllable timer scheduler. The scheduler
 * lets each test fire ticks one at a time via `scheduler.tick(ms)`,
 * which advances Date.now() and invokes the registered callback.
 *
 * Why a custom scheduler rather than vi.useFakeTimers(): the
 * adapter's #tick uses Date.now() deltas, and vi.advanceTimersByTime
 * only moves the timer's notion of "now" — Date.now() still returns
 * the real clock. We need both moving in lockstep, which is what
 * the scheduler does.
 */
function makeAdapter() {
  let now = 1_000_000;
  const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

  let registered: (() => void) | null = null;
  let interval = 0;
  const setIntervalImpl = (fn: () => void, ms: number) => {
    registered = fn;
    interval = ms;
    return 1 as unknown as ReturnType<typeof setInterval>;
  };
  const clearIntervalImpl = () => {
    registered = null;
    interval = 0;
  };

  const adapter = new MockSpotifyAdapter({ setIntervalImpl, clearIntervalImpl });

  const advance = (ms: number) => {
    now += ms;
    if (registered) registered();
  };

  const advanceWithoutTick = (ms: number) => {
    now += ms;
  };

  const isTimerRunning = () => registered !== null;
  const tickIntervalMs = () => interval;

  const teardown = () => dateNowSpy.mockRestore();

  return {
    adapter,
    advance,
    advanceWithoutTick,
    isTimerRunning,
    tickIntervalMs,
    teardown,
  };
}

describe('MockSpotifyAdapter — basic state machine', () => {
  it('reports source = spotify', () => {
    const { adapter, teardown } = makeAdapter();
    expect(adapter.source).toBe('spotify');
    teardown();
  });

  it('loads a spotify track and sets initial state', async () => {
    const { adapter, isTimerRunning, teardown } = makeAdapter();
    await adapter.load(TRACK);
    expect(adapter.getPositionMs()).toBe(0);
    expect(adapter.getDurationMs()).toBe(TRACK.durationMs);
    expect(isTimerRunning()).toBe(false); // load() does not start playing
    teardown();
  });

  it('rejects non-spotify tracks', async () => {
    const { adapter, teardown } = makeAdapter();
    const local: UnifiedTrack = { ...TRACK, source: 'local', id: 'x', sourceId: '/x' };
    await expect(adapter.load(local)).rejects.toThrow(
      /cannot load track from source 'local'/,
    );
    teardown();
  });

  it('play() throws before load()', async () => {
    const { adapter, teardown } = makeAdapter();
    await expect(adapter.play()).rejects.toThrow(/before load/);
    teardown();
  });

  it('returns null from getVisualElement (audio-only)', async () => {
    const { adapter, teardown } = makeAdapter();
    await adapter.load(TRACK);
    expect(adapter.getVisualElement()).toBe(null);
    teardown();
  });
});

describe('MockSpotifyAdapter — playback', () => {
  it('play() starts the timer; pause() stops it', async () => {
    const { adapter, isTimerRunning, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    expect(isTimerRunning()).toBe(true);
    await adapter.pause();
    expect(isTimerRunning()).toBe(false);
    teardown();
  });

  it('position advances on tick', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    advance(200);
    expect(adapter.getPositionMs()).toBe(200);
    advance(200);
    expect(adapter.getPositionMs()).toBe(400);
    teardown();
  });

  it('fires timeupdate listeners on each tick', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    const cb = vi.fn();
    adapter.on('timeupdate', cb);
    await adapter.load(TRACK);
    await adapter.play();
    advance(200);
    advance(200);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(400);
    teardown();
  });

  it('does not advance position while paused', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    advance(200);
    await adapter.pause();
    // Timer has been stopped; no further ticks will fire. Sanity
    // check by trying to advance — the registered callback is gone.
    advance(1000);
    expect(adapter.getPositionMs()).toBe(200);
    teardown();
  });

  it('double-play is a no-op (idempotent)', async () => {
    const { adapter, isTimerRunning, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    await adapter.play();
    expect(isTimerRunning()).toBe(true);
    teardown();
  });
});

describe('MockSpotifyAdapter — ended', () => {
  it('fires ended once when position reaches duration', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    const endedCb = vi.fn();
    adapter.on('ended', endedCb);
    await adapter.load(TRACK);
    await adapter.play();
    advance(TRACK.durationMs); // tick advances by full duration
    expect(endedCb).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('clamps position to duration on overshoot', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    advance(TRACK.durationMs + 1000); // overshoot
    expect(adapter.getPositionMs()).toBe(TRACK.durationMs);
    teardown();
  });

  it('stops the timer after ended fires', async () => {
    const { adapter, advance, isTimerRunning, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    advance(TRACK.durationMs);
    expect(isTimerRunning()).toBe(false);
    teardown();
  });

  it('fires a final timeupdate at duration before ended', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    const calls: Array<{ kind: 'time' | 'ended'; ms?: number }> = [];
    adapter.on('timeupdate', (ms) => calls.push({ kind: 'time', ms }));
    adapter.on('ended', () => calls.push({ kind: 'ended' }));
    await adapter.load(TRACK);
    await adapter.play();
    advance(TRACK.durationMs);
    // Last timeupdate is at duration; ended follows immediately.
    const lastTime = calls.filter((c) => c.kind === 'time').slice(-1)[0];
    expect(lastTime?.ms).toBe(TRACK.durationMs);
    const endedIdx = calls.findIndex((c) => c.kind === 'ended');
    const lastTimeIdx = calls.lastIndexOf(lastTime!);
    expect(endedIdx).toBeGreaterThan(lastTimeIdx);
    teardown();
  });
});

describe('MockSpotifyAdapter — seek', () => {
  it('moves position to the requested point', async () => {
    const { adapter, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.seek(2_000);
    expect(adapter.getPositionMs()).toBe(2_000);
    teardown();
  });

  it('clamps slight overruns silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.seek(TRACK.durationMs + 5); // slight overrun
    expect(adapter.getPositionMs()).toBe(TRACK.durationMs);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    teardown();
  });

  it('warns on gross overruns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.seek(TRACK.durationMs * 5);
    expect(adapter.getPositionMs()).toBe(TRACK.durationMs);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    teardown();
  });

  it('clamps negative values to 0', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.seek(-50_000); // gross negative
    expect(adapter.getPositionMs()).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    teardown();
  });

  it('fires a timeupdate immediately on seek', async () => {
    const { adapter, teardown } = makeAdapter();
    const cb = vi.fn();
    adapter.on('timeupdate', cb);
    await adapter.load(TRACK);
    await adapter.seek(1234);
    expect(cb).toHaveBeenCalledWith(1234);
    teardown();
  });

  it('next tick advances from the seeked position', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.seek(1000);
    await adapter.play();
    advance(200);
    expect(adapter.getPositionMs()).toBe(1200);
    teardown();
  });
});

describe('MockSpotifyAdapter — unload + cleanup', () => {
  it('unload stops the timer', async () => {
    const { adapter, isTimerRunning, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    expect(isTimerRunning()).toBe(true);
    await adapter.unload();
    expect(isTimerRunning()).toBe(false);
    teardown();
  });

  it('unload clears listeners (multiple sequential loads do not leak)', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    const cb = vi.fn();
    adapter.on('timeupdate', cb);
    await adapter.load(TRACK);
    await adapter.unload();

    // Second load + play — old listener should not fire.
    await adapter.load(TRACK);
    await adapter.play();
    advance(200);
    expect(cb).not.toHaveBeenCalled();
    teardown();
  });

  it('unload resets position and duration', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    await adapter.load(TRACK);
    await adapter.play();
    advance(500);
    await adapter.unload();
    expect(adapter.getPositionMs()).toBe(0);
    expect(adapter.getDurationMs()).toBe(0);
    teardown();
  });

  it('unsubscribe handle stops a single listener without affecting others', async () => {
    const { adapter, advance, teardown } = makeAdapter();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = adapter.on('timeupdate', a);
    adapter.on('timeupdate', b);
    await adapter.load(TRACK);
    await adapter.play();
    advance(200);
    unsubA();
    advance(200);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    teardown();
  });
});

describe('MockSpotifyAdapter — duration', () => {
  it('reports durationMs from the loaded track', async () => {
    const { adapter, teardown } = makeAdapter();
    await adapter.load(TRACK);
    expect(adapter.getDurationMs()).toBe(TRACK.durationMs);
    teardown();
  });

  it('reports 0 before any load', () => {
    const { adapter, teardown } = makeAdapter();
    expect(adapter.getDurationMs()).toBe(0);
    teardown();
  });
});
