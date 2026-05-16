import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlayerManager } from './PlayerManager';
import type {
  PlaybackAdapter,
  Source,
  UnifiedTrack,
  Unsubscribe,
} from './types';
import { PRELOAD_LEAD_MS, PREVIOUS_RESTART_THRESHOLD_MS } from './constants';

class FakePlaybackAdapter implements PlaybackAdapter {
  readonly source: Source;

  loadedTrack: UnifiedTrack | null = null;
  volume = 1;
  positionMs = 0;
  isPlayingFlag = false;

  /** Override what `getDurationMs()` reports. Defaults to the loaded
   *  track's metadata duration. Setting this simulates the
   *  adapter-vs-metadata disagreement case (Chromium reporting a
   *  different duration than music-metadata for the same MP3 file). */
  reportedDurationMs: number | null = null;

  loadCount = 0;
  playCount = 0;
  pauseCount = 0;
  unloadCount = 0;
  seekCount = 0;
  setVolumeCount = 0;

  loadShouldFail = false;
  playShouldFail = false;

  #timeupdate = new Set<(ms: number) => void>();
  #ended = new Set<() => void>();
  #error = new Set<(err: Error) => void>();

  constructor(source: Source) {
    this.source = source;
  }

  async load(track: UnifiedTrack): Promise<void> {
    this.loadCount++;
    if (this.loadShouldFail) throw new Error('fake: load failed');
    this.loadedTrack = track;
  }

  async play(): Promise<void> {
    this.playCount++;
    if (this.playShouldFail) throw new Error('fake: play failed');
    this.isPlayingFlag = true;
  }

  async pause(): Promise<void> {
    this.pauseCount++;
    this.isPlayingFlag = false;
  }

  async seek(ms: number): Promise<void> {
    this.seekCount++;
    this.positionMs = ms;
  }

  async setVolume(v: number): Promise<void> {
    this.setVolumeCount++;
    this.volume = v;
  }

  async unload(): Promise<void> {
    this.unloadCount++;
    this.isPlayingFlag = false;
    this.#timeupdate.clear();
    this.#ended.clear();
    this.#error.clear();
  }

  getPositionMs(): number {
    return this.positionMs;
  }

  getDurationMs(): number {
    if (this.reportedDurationMs !== null) return this.reportedDurationMs;
    return this.loadedTrack?.durationMs ?? 0;
  }

  getVisualElement(): HTMLElement | null {
    return null;
  }

  on(event: 'timeupdate', cb: (ms: number) => void): Unsubscribe;
  on(event: 'ended', cb: () => void): Unsubscribe;
  on(event: 'error', cb: (err: Error) => void): Unsubscribe;
  on(
    event: 'timeupdate' | 'ended' | 'error',
    cb: ((ms: number) => void) | (() => void) | ((err: Error) => void),
  ): Unsubscribe {
    switch (event) {
      case 'timeupdate': {
        const fn = cb as (ms: number) => void;
        this.#timeupdate.add(fn);
        return () => {
          this.#timeupdate.delete(fn);
        };
      }
      case 'ended': {
        const fn = cb as () => void;
        this.#ended.add(fn);
        return () => {
          this.#ended.delete(fn);
        };
      }
      case 'error': {
        const fn = cb as (err: Error) => void;
        this.#error.add(fn);
        return () => {
          this.#error.delete(fn);
        };
      }
    }
  }

  emitTimeUpdate(ms: number): void {
    this.positionMs = ms;
    for (const cb of this.#timeupdate) cb(ms);
  }
  emitEnded(): void {
    for (const cb of this.#ended) cb();
  }
  emitError(err: Error): void {
    for (const cb of this.#error) cb(err);
  }
}

class FakeAdapterFactory {
  readonly allocations: FakePlaybackAdapter[] = [];

  create = (source: Source): PlaybackAdapter => {
    const a = new FakePlaybackAdapter(source);
    this.allocations.push(a);
    return a;
  };

  forTrack(trackId: string): FakePlaybackAdapter | undefined {
    return this.allocations.find((a) => a.loadedTrack?.id === trackId);
  }
}

const track = (id: string, durationMs = 60_000, source: Source = 'local'): UnifiedTrack => ({
  id,
  source,
  sourceId: `/test/${id}.mp3`,
  title: `Track ${id}`,
  artists: ['Tester'],
  durationMs,
});

const trackList = (...ids: string[]): readonly UnifiedTrack[] => ids.map((id) => track(id));

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('PlayerManager — setQueue', () => {
  let factory: FakeAdapterFactory;
  beforeEach(() => {
    factory = new FakeAdapterFactory();
  });

  it('does nothing useful with empty queue', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue([]);
    expect(pm.getState().playbackState).toBe('idle');
    expect(pm.getState().current).toBeNull();
  });

  it('autoplays from cursor 0 by default', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c'));
    expect(pm.getState().playbackState).toBe('playing');
    expect(pm.getState().current?.id).toBe('a');
    const a = factory.forTrack('a');
    expect(a?.playCount).toBe(1);
  });

  it("respects autoplay: false (loads but doesn't play)", async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b'), { autoplay: false });
    expect(pm.getState().playbackState).toBe('paused');
    expect(pm.getState().current?.id).toBe('a');
    const a = factory.forTrack('a');
    expect(a?.loadCount).toBe(1);
    expect(a?.playCount).toBe(0);
  });

  it('starts at the chosen cursor', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c'), { cursor: 2 });
    expect(pm.getState().current?.id).toBe('c');
  });

  it('clamps out-of-range cursor', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b'), { cursor: 99 });
    expect(pm.getState().current?.id).toBe('b');
  });

  it('disposes existing playback when called again', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const aAdapter = factory.forTrack('a')!;
    await pm.setQueue(trackList('x', 'y'));
    expect(aAdapter.unloadCount).toBe(1);
    expect(pm.getState().current?.id).toBe('x');
  });

  it('sets the current adapter to user volume on load', async () => {
    const pm = new PlayerManager({
      createAdapter: factory.create,
      initialVolume: 0.5,
    });
    await pm.setQueue(trackList('a'));
    expect(factory.forTrack('a')?.volume).toBe(0.5);
  });
});

describe('PlayerManager — adapter-reported duration', () => {
  it('overrides metadata durationMs with adapter-reported value at load', async () => {
    const factory = new FakeAdapterFactory();
    const customCreate = (source: Source): PlaybackAdapter => {
      const a = new FakePlaybackAdapter(source);
      a.reportedDurationMs = 214_000;
      factory.allocations.push(a);
      return a;
    };
    const pm = new PlayerManager({ createAdapter: customCreate });
    await pm.setQueue([track('a', 192_000)]);
    expect(pm.getState().current?.durationMs).toBe(214_000);
  });

  it('keeps metadata duration if adapter reports 0 (not yet known)', async () => {
    const factory = new FakeAdapterFactory();
    const customCreate = (source: Source): PlaybackAdapter => {
      const a = new FakePlaybackAdapter(source);
      a.reportedDurationMs = 0;
      factory.allocations.push(a);
      return a;
    };
    const pm = new PlayerManager({ createAdapter: customCreate });
    await pm.setQueue([track('a', 180_000)]);
    expect(pm.getState().current?.durationMs).toBe(180_000);
  });

  it('updates duration mid-playback when adapter revises it (Chromium pattern)', async () => {
    const factory = new FakeAdapterFactory();
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue([track('a', 192_000)]);
    expect(pm.getState().current?.durationMs).toBe(192_000);

    // Simulate Chromium revising <audio>.duration after playback starts —
    // the adapter now reports a different value, and the next timeupdate
    // should pick it up.
    const a = factory.forTrack('a')!;
    a.reportedDurationMs = 214_000;
    a.emitTimeUpdate(100_000);

    expect(pm.getState().current?.durationMs).toBe(214_000);
  });
});

describe('PlayerManager — transport', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c'));
  });

  it('pause stops the current adapter', async () => {
    await pm.pause();
    expect(pm.getState().playbackState).toBe('paused');
    expect(factory.forTrack('a')?.pauseCount).toBe(1);
  });

  it('play resumes after pause', async () => {
    await pm.pause();
    await pm.play();
    expect(pm.getState().playbackState).toBe('playing');
    expect(factory.forTrack('a')?.playCount).toBe(2);
  });

  it('togglePlayPause flips between states', async () => {
    await pm.togglePlayPause();
    expect(pm.getState().playbackState).toBe('paused');
    await pm.togglePlayPause();
    expect(pm.getState().playbackState).toBe('playing');
  });

  it('seek delegates to the current adapter', async () => {
    await pm.seek(15_000);
    expect(factory.forTrack('a')?.seekCount).toBe(1);
    expect(factory.forTrack('a')?.positionMs).toBe(15_000);
  });

  it('seek with no current is a no-op (no throw)', async () => {
    const empty = new PlayerManager({ createAdapter: factory.create });
    await expect(empty.seek(1000)).resolves.toBeUndefined();
  });
});

describe('PlayerManager — next / previous', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c'));
  });

  it('next advances cursor and plays', async () => {
    await pm.next();
    expect(pm.getState().current?.id).toBe('b');
    expect(pm.getState().queue.cursor).toBe(1);
    expect(factory.forTrack('b')?.playCount).toBe(1);
  });

  it('next at end of queue is a no-op', async () => {
    await pm.next();
    await pm.next();
    expect(pm.getState().current?.id).toBe('c');
    await pm.next();
    expect(pm.getState().current?.id).toBe('c');
  });

  it('previous restarts current track when past threshold', async () => {
    factory.forTrack('a')!.emitTimeUpdate(PREVIOUS_RESTART_THRESHOLD_MS + 1_000);
    await pm.previous();
    expect(pm.getState().current?.id).toBe('a');
    expect(factory.forTrack('a')?.seekCount).toBe(1);
    expect(factory.forTrack('a')?.positionMs).toBe(0);
  });

  it('previous goes to actual previous when within threshold', async () => {
    await pm.next();
    factory.forTrack('b')!.emitTimeUpdate(500);
    await pm.previous();
    expect(pm.getState().current?.id).toBe('a');
    expect(pm.getState().queue.cursor).toBe(0);
  });

  it('previous at cursor 0 with position=0 is a no-op', async () => {
    expect(pm.getState().current?.id).toBe('a');
    expect(pm.getState().positionMs).toBe(0);
    await pm.previous();
    expect(pm.getState().current?.id).toBe('a');
  });

  it('next disposes the previous current adapter', async () => {
    const aAdapter = factory.forTrack('a')!;
    await pm.next();
    expect(aAdapter.unloadCount).toBe(1);
  });
});

describe('PlayerManager — preload + handoff', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c'));
  });

  it('preloads next track when remaining <= PRELOAD_LEAD_MS', async () => {
    const aAdapter = factory.forTrack('a')!;
    aAdapter.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    expect(factory.forTrack('b')).toBeDefined();
    expect(factory.forTrack('b')?.loadCount).toBe(1);
  });

  it('preloaded next is held at volume 0', async () => {
    factory.forTrack('a')!.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    expect(factory.forTrack('b')?.volume).toBe(0);
  });

  it('does not preload before threshold', async () => {
    factory.forTrack('a')!.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS - 1_000);
    await settle();
    expect(factory.forTrack('b')).toBeUndefined();
  });

  it('does not preload twice', async () => {
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 100);
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 200);
    await settle();
    const bAllocations = factory.allocations.filter((x) => x.loadedTrack?.id === 'b');
    expect(bAllocations.length).toBe(1);
  });

  it('on ended, promotes preloaded next without re-allocating', async () => {
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    const bBeforeEnded = factory.forTrack('b')!;
    a.emitEnded();
    await settle();
    expect(pm.getState().current?.id).toBe('b');
    expect(bBeforeEnded.playCount).toBe(1);
    expect(bBeforeEnded.volume).toBe(1);
  });

  it('on promotion, old current is unloaded AFTER new one is playing', async () => {
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    const b = factory.forTrack('b')!;

    a.emitEnded();
    await settle();
    expect(b.playCount).toBe(1);
    expect(a.unloadCount).toBe(1);
  });

  it('two-audible-adapters guard: at no observable point are both adapters at user volume', async () => {
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    const b = factory.forTrack('b')!;
    expect(a.volume).toBe(1);
    expect(b.volume).toBe(0);

    a.emitEnded();
    await settle();
    expect(b.volume).toBe(1);
    expect(a.unloadCount).toBe(1);
  });

  it('stops at end of queue, retains queue', async () => {
    await pm.jumpTo(2);
    const c = factory.forTrack('c')!;
    c.emitEnded();
    await settle();
    expect(pm.getState().playbackState).toBe('idle');
    expect(pm.getState().current).toBeNull();
    expect(pm.getState().queue.items.length).toBe(3);
    expect(pm.getState().queue.cursor).toBe(2);
  });
});

describe('PlayerManager — preload cancellation', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c'));
  });

  it('skip during preload disposes the preloaded adapter', async () => {
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    const b = factory.forTrack('b')!;

    await pm.jumpTo(2);

    expect(b.unloadCount).toBe(1);
    expect(pm.getState().current?.id).toBe('c');
    expect(pm.getState().next).toBeNull();
  });

  it('jumpTo cancels in-flight preload', async () => {
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    expect(factory.forTrack('b')).toBeDefined();

    await pm.jumpTo(2);
    expect(factory.forTrack('b')?.unloadCount).toBe(1);
  });
});

describe('PlayerManager — jumpTo', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b', 'c', 'd'));
  });

  it('jumps to arbitrary index and plays', async () => {
    await pm.jumpTo(2);
    expect(pm.getState().current?.id).toBe('c');
    expect(pm.getState().queue.cursor).toBe(2);
    expect(factory.forTrack('c')?.playCount).toBe(1);
  });

  it('out-of-range cursor is a no-op', async () => {
    await pm.jumpTo(99);
    expect(pm.getState().current?.id).toBe('a');
    await pm.jumpTo(-1);
    expect(pm.getState().current?.id).toBe('a');
  });

  it('jumping to current cursor restarts (seek 0)', async () => {
    factory.forTrack('a')!.emitTimeUpdate(15_000);
    await pm.jumpTo(0);
    expect(factory.forTrack('a')?.seekCount).toBe(1);
    expect(factory.forTrack('a')?.positionMs).toBe(0);
  });
});

describe('PlayerManager — volume', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({
      createAdapter: factory.create,
      initialVolume: 0.7,
    });
    await pm.setQueue(trackList('a', 'b'));
  });

  it('initialVolume is applied to current on load', () => {
    expect(factory.forTrack('a')?.volume).toBe(0.7);
  });

  it('setVolume updates current adapter only, not preloaded next', async () => {
    factory.forTrack('a')!.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    pm.setVolume(0.3);
    await settle();
    expect(factory.forTrack('a')?.volume).toBe(0.3);
    expect(factory.forTrack('b')?.volume).toBe(0);
  });

  it('setVolume clamps to [0, 1]', () => {
    pm.setVolume(2);
    expect(pm.getState().volume).toBe(1);
    pm.setVolume(-5);
    expect(pm.getState().volume).toBe(0);
  });

  it('handoff applies latest userVolume (not the value at preload time)', async () => {
    factory.forTrack('a')!.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    pm.setVolume(0.4);
    await settle();
    factory.forTrack('a')!.emitEnded();
    await settle();
    expect(factory.forTrack('b')?.volume).toBe(0.4);
  });
});

describe('PlayerManager — state subscription', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(async () => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b'));
  });

  it('emits on transport changes', async () => {
    const cb = vi.fn();
    pm.on('state', cb);
    await pm.pause();
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.lastCall?.[0].playbackState).toBe('paused');
  });

  it('emits on timeupdate (position changes)', () => {
    const cb = vi.fn();
    pm.on('state', cb);
    factory.forTrack('a')!.emitTimeUpdate(5_000);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.lastCall?.[0].positionMs).toBe(5_000);
  });

  it('unsubscribe stops further emissions', async () => {
    const cb = vi.fn();
    const off = pm.on('state', cb);
    off();
    await pm.pause();
    expect(cb).not.toHaveBeenCalled();
  });

  it('snapshot includes canGoPrevious / canGoNext', async () => {
    expect(pm.getState().canGoPrevious).toBe(false);
    expect(pm.getState().canGoNext).toBe(true);
    await pm.next();
    expect(pm.getState().canGoPrevious).toBe(true);
    expect(pm.getState().canGoNext).toBe(false);
  });
});

describe('PlayerManager — error handling', () => {
  let factory: FakeAdapterFactory;
  beforeEach(() => {
    factory = new FakeAdapterFactory();
  });

  it('load failure sets error state', async () => {
    const failingFactory = (source: Source): PlaybackAdapter => {
      const a = new FakePlaybackAdapter(source);
      a.loadShouldFail = true;
      factory.allocations.push(a);
      return a;
    };
    const pm = new PlayerManager({ createAdapter: failingFactory });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pm.setQueue(trackList('a'));
    expect(pm.getState().playbackState).toBe('error');
    errSpy.mockRestore();
  });

  it('current adapter error event sets error state', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factory.forTrack('a')!.emitError(new Error('local: decode failure'));
    expect(pm.getState().playbackState).toBe('error');
    errSpy.mockRestore();
  });

  it('generic Error leaves playbackError null', async () => {
    // Non-structured errors flip playbackState to 'error' but don't
    // populate the structured field — the UI's targeted affordances
    // are reserved for cases the adapter has categorized.
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factory.forTrack('a')!.emitError(new Error('local: decode failure'));
    expect(pm.getState().playbackError).toBeNull();
    errSpy.mockRestore();
  });

  it('structured error populates playbackError with reason + watchUrl', async () => {
    // Duck-typed: any Error subclass with a `reason` field in the
    // allowed union and an optional `watchUrl` qualifies. The shape
    // matches YouTubeUnplayableError without PlayerManager having to
    // import it.
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const structured = Object.assign(
      new Error('youtube: player error (code 101, reason embed-disallowed)'),
      {
        reason: 'embed-disallowed' as const,
        watchUrl: 'https://www.youtube.com/watch?v=abc',
      },
    );
    factory.forTrack('a')!.emitError(structured);
    expect(pm.getState().playbackError).toEqual({
      reason: 'embed-disallowed',
      watchUrl: 'https://www.youtube.com/watch?v=abc',
    });
    errSpy.mockRestore();
  });

  it('structured error without watchUrl omits the field on PlaybackError', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const structured = Object.assign(new Error('youtube: not-found'), {
      reason: 'not-found' as const,
    });
    factory.forTrack('a')!.emitError(structured);
    const e = pm.getState().playbackError;
    expect(e?.reason).toBe('not-found');
    expect(e).not.toHaveProperty('watchUrl');
    errSpy.mockRestore();
  });

  it('rejects an unknown reason value', async () => {
    // The coercion is closed: if the `reason` field carries
    // something outside the allowed literal union, PlayerManager
    // treats it as a non-structured error and leaves the field null.
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const malformed = Object.assign(new Error('bogus'), {
      reason: 'something-else',
    });
    factory.forTrack('a')!.emitError(malformed);
    expect(pm.getState().playbackError).toBeNull();
    expect(pm.getState().playbackState).toBe('error');
    errSpy.mockRestore();
  });

  it('clears playbackError on track change (next)', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const structured = Object.assign(new Error('youtube: embed-disallowed'), {
      reason: 'embed-disallowed' as const,
      watchUrl: 'https://www.youtube.com/watch?v=abc',
    });
    factory.forTrack('a')!.emitError(structured);
    expect(pm.getState().playbackError).not.toBeNull();

    await pm.next();
    expect(pm.getState().playbackError).toBeNull();
    errSpy.mockRestore();
  });

  it('clears playbackError on setQueue', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const structured = Object.assign(new Error('youtube: not-found'), {
      reason: 'not-found' as const,
    });
    factory.forTrack('a')!.emitError(structured);
    expect(pm.getState().playbackError).not.toBeNull();

    await pm.setQueue(trackList('b'));
    expect(pm.getState().playbackError).toBeNull();
    errSpy.mockRestore();
  });

  it('clears playbackError when queue ends (handleEnded → no newTrack)', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const structured = Object.assign(new Error('youtube: not-found'), {
      reason: 'not-found' as const,
    });
    const adapter = factory.forTrack('a')!;
    adapter.emitError(structured);
    expect(pm.getState().playbackError).not.toBeNull();
    // End of track, no next — disposeCurrent runs, error clears.
    adapter.emitEnded();
    await settle();
    expect(pm.getState().playbackError).toBeNull();
    errSpy.mockRestore();
  });

  it('clears playbackError on setQueue([]) (empty queue)', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factory.forTrack('a')!.emitError(
      Object.assign(new Error('youtube: not-found'), { reason: 'not-found' as const }),
    );
    expect(pm.getState().playbackError).not.toBeNull();
    await pm.setQueue([]);
    expect(pm.getState().playbackError).toBeNull();
    errSpy.mockRestore();
  });

  it('dismissError clears playbackError without changing playbackState', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factory.forTrack('a')!.emitError(
      Object.assign(new Error('youtube: not-found'), { reason: 'not-found' as const }),
    );
    expect(pm.getState().playbackError).not.toBeNull();
    expect(pm.getState().playbackState).toBe('error');

    pm.dismissError();
    expect(pm.getState().playbackError).toBeNull();
    // playbackState is *not* reset — the user-acknowledgement only
    // hides the affordance; actual playback is still broken until the
    // next track loads.
    expect(pm.getState().playbackState).toBe('error');
    errSpy.mockRestore();
  });

  it('dismissError is a no-op when playbackError is null', async () => {
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a'));
    const stateBefore = pm.getState();
    pm.dismissError();
    // Snapshot reference unchanged because no emit fired — we test
    // the observable: error stays null, no exception thrown.
    expect(pm.getState().playbackError).toBeNull();
    expect(pm.getState().playbackState).toBe(stateBefore.playbackState);
  });
});

describe('PlayerManager — enqueue', () => {
  let factory: FakeAdapterFactory;
  let pm: PlayerManager;

  beforeEach(() => {
    factory = new FakeAdapterFactory();
    pm = new PlayerManager({ createAdapter: factory.create });
  });

  it('appends to queue without touching current or next', async () => {
    await pm.setQueue(trackList('a', 'b'));
    const aBefore = factory.forTrack('a')!;
    const aLoadCountBefore = aBefore.loadCount;

    pm.enqueue(track('c'));

    expect(pm.getState().queue.items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(pm.getState().queue.cursor).toBe(0);
    // Current adapter is undisturbed — no reload, no pause, nothing.
    expect(aBefore.loadCount).toBe(aLoadCountBefore);
    expect(aBefore.pauseCount).toBe(0);
    expect(aBefore.unloadCount).toBe(0);
    // No preload yet — we're nowhere near the preload window.
    expect(factory.forTrack('c')).toBeUndefined();
  });

  it('appends to an empty queue without starting playback', () => {
    pm.enqueue(track('a'));
    expect(pm.getState().queue.items.map((t) => t.id)).toEqual(['a']);
    expect(pm.getState().playbackState).toBe('idle');
    expect(pm.getState().current).toBeNull();
    // No adapter allocated — enqueue does not load.
    expect(factory.allocations.length).toBe(0);
  });

  it('emits a state update so subscribers see the new queue', async () => {
    await pm.setQueue(trackList('a'));
    const states: number[] = [];
    pm.on('state', (s) => states.push(s.queue.items.length));
    pm.enqueue(track('b'));
    expect(states[states.length - 1]).toBe(2);
  });

  // THE critical test — locks in the preload-no-op-doesn't-poison-the-flag
  // behavior described in the enqueue() doc comment.
  //
  // Setup: queue is a single track, the current track is *inside* the
  // preload window (so the timeupdate has fired with no next track in
  // the queue, and the preload condition's queue-non-empty check
  // short-circuited it). The flag should NOT have been set; the next
  // timeupdate after enqueue should fire preload normally.
  it('fires preload on next timeupdate when enqueued late in playback', async () => {
    await pm.setQueue([track('a', 60_000)]);
    const a = factory.forTrack('a')!;

    // Drive a timeupdate well inside the preload window. Queue is
    // [a] only, so the preload condition exits without setting the
    // flag — there's no next track to preload.
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_000);
    await settle();
    expect(factory.allocations.length).toBe(1); // still just 'a'

    // User appends 'b'. Pure queue mutation.
    pm.enqueue(track('b', 30_000));
    await settle();
    // Still no preload — enqueue itself doesn't trigger one.
    expect(factory.forTrack('b')).toBeUndefined();

    // Next timeupdate (the actual mechanism, what the adapter would
    // emit ~200–250ms later). Preload should fire now.
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_500);
    await settle();
    expect(factory.forTrack('b')).toBeDefined();
    expect(factory.forTrack('b')?.loadCount).toBe(1);
    expect(factory.forTrack('b')?.volume).toBe(0); // muted, per invariant
  });

  it('enqueue followed by track-ending hands off to the appended track', async () => {
    await pm.setQueue([track('a', 60_000)]);
    const a = factory.forTrack('a')!;

    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_000);
    await settle();

    pm.enqueue(track('b', 30_000));
    await settle();

    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_500);
    await settle();

    // Preload happened; now end the current.
    const b = factory.forTrack('b')!;
    a.emitEnded();
    await settle();

    expect(pm.getState().current?.id).toBe('b');
    expect(b.playCount).toBe(1);
    expect(b.volume).toBe(1);
    expect(a.unloadCount).toBe(1);
  });

  it('cross-source enqueue: local current + youtube appended → handoff', async () => {
    await pm.setQueue([track('a', 60_000, 'local')]);
    const a = factory.forTrack('a')!;

    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_000);
    await settle();

    // The YouTube track gets a different `source` — the fake factory
    // doesn't care about source identity but the slot's record does.
    pm.enqueue(track('yt', 30_000, 'youtube'));
    await settle();

    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_500);
    await settle();
    // YouTube tracks are NOT preloaded — the priming step is omitted, so
    // cold-start at handoff is the design. Verify the YouTube adapter
    // does NOT exist during what would otherwise have been the preload
    // window. See PlayerManager.#preloadNext for the why.
    expect(factory.forTrack('yt')).toBeUndefined();

    a.emitEnded();
    await settle();
    // Handoff creates the YT adapter cold-start.
    expect(factory.forTrack('yt')).toBeDefined();
    expect(factory.forTrack('yt')?.source).toBe('youtube');
    expect(pm.getState().current?.id).toBe('yt');
    expect(pm.getState().current?.source).toBe('youtube');
  });

  // Belt-and-suspenders: enqueue after a fully-completed preload (a
  // already preloaded b, then user appends c). The previously-set
  // #preloadStarted flag should NOT cause c to be preloaded — that
  // only happens after promotion, when the flag is reset.
  it('does not over-eagerly preload past the immediate next slot', async () => {
    await pm.setQueue(trackList('a', 'b'));
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    expect(factory.forTrack('b')).toBeDefined();

    // Now append c. The cursor is still 0, so cursor+1 is 'b' (already
    // preloaded). 'c' is at cursor+2 and never gets preloaded — only
    // the immediate next slot is held warm.
    pm.enqueue(track('c'));
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 500);
    await settle();
    expect(factory.forTrack('c')).toBeUndefined();
  });

  it('after promotion, enqueueing onto a 1-deep queue still preloads', async () => {
    await pm.setQueue(trackList('a', 'b'));
    const a = factory.forTrack('a')!;
    a.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();
    a.emitEnded();
    await settle();
    // Now playing 'b', queue is [a, b] with cursor=1, no next.
    expect(pm.getState().current?.id).toBe('b');

    const b = factory.forTrack('b')!;
    b.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_000);
    await settle();
    // No next track → preload doesn't fire, flag stays false.
    expect(factory.allocations.filter((x) => x.loadedTrack?.id === 'c').length).toBe(0);

    pm.enqueue(track('c'));
    b.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS + 1_500);
    await settle();
    // Now preload fires for c.
    expect(factory.forTrack('c')).toBeDefined();
  });
});

describe('PlayerManager — dispose', () => {
  it('disposes all adapters and rejects further calls', async () => {
    const factory = new FakeAdapterFactory();
    const pm = new PlayerManager({ createAdapter: factory.create });
    await pm.setQueue(trackList('a', 'b'));
    factory.forTrack('a')!.emitTimeUpdate(60_000 - PRELOAD_LEAD_MS);
    await settle();

    await pm.dispose();
    expect(factory.forTrack('a')?.unloadCount).toBe(1);
    expect(factory.forTrack('b')?.unloadCount).toBe(1);
    await expect(pm.play()).rejects.toThrow(/disposed/);
  });
});
