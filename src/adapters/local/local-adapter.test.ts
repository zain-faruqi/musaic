import { describe, it, expect, vi } from 'vitest';
import { LocalAdapter } from './local-adapter';
import type { UnifiedTrack } from '@renderer/core/types';

class FakeMediaElement extends EventTarget {
  src = '';
  volume = 1;
  currentTime = 0;
  duration = NaN;
  preload: '' | 'auto' | 'metadata' | 'none' = '';
  error: { code: number; message: string } | null = null;

  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });

  fireCanPlay(durationSec = 60): void {
    this.duration = durationSec;
    this.dispatchEvent(new Event('canplay'));
  }
  fireTimeUpdate(seconds: number): void {
    this.currentTime = seconds;
    this.dispatchEvent(new Event('timeupdate'));
  }
  fireEnded(): void {
    this.dispatchEvent(new Event('ended'));
  }
  fireError(code = 4, message = 'fake error'): void {
    this.error = { code, message };
    this.dispatchEvent(new Event('error'));
  }
  /** Simulate Chromium revising duration after canplay (e.g. as more
   *  decodable frames are discovered mid-playback). */
  reviseDuration(durationSec: number): void {
    this.duration = durationSec;
    this.dispatchEvent(new Event('durationchange'));
  }
}

const audioTrack: UnifiedTrack = {
  id: 'local-1',
  source: 'local',
  sourceId: '/Users/test/song.mp3',
  title: 'Test Song',
  artists: ['Tester'],
  durationMs: 180_000,
};

const videoTrack: UnifiedTrack = {
  id: 'local-2',
  source: 'local',
  sourceId: '/Users/test/clip.mp4',
  title: 'Test Clip',
  artists: ['Tester'],
  durationMs: 60_000,
};

const setup = () => {
  const element = new FakeMediaElement();
  let kindUsed: 'audio' | 'video' | null = null;
  const createElement = vi.fn((kind: 'audio' | 'video') => {
    kindUsed = kind;
    return element as unknown as HTMLMediaElement;
  });
  const adapter = new LocalAdapter({ createElement });
  return { adapter, element, createElement, getKind: (): 'audio' | 'video' | null => kindUsed };
};

const setupLoaded = async (track: UnifiedTrack = audioTrack, durationSec = 180) => {
  const s = setup();
  const p = s.adapter.load(track);
  s.element.fireCanPlay(durationSec);
  await p;
  return s;
};

describe('LocalAdapter — load', () => {
  it('rejects tracks from non-local sources', async () => {
    const { adapter } = setup();
    const ytTrack = { ...audioTrack, source: 'youtube' as const };
    await expect(adapter.load(ytTrack)).rejects.toThrow(/cannot load.*youtube/);
  });

  it('creates an audio element for audio files', async () => {
    const { getKind } = await setupLoaded(audioTrack);
    expect(getKind()).toBe('audio');
  });

  it('creates a video element for video files', async () => {
    const { getKind } = await setupLoaded(videoTrack);
    expect(getKind()).toBe('video');
  });

  it('sets src to a musaic-file:// URL with the encoded path', async () => {
    const { element } = await setupLoaded(audioTrack);
    expect(element.src).toMatch(/^musaic-file:\/\//);
    expect(element.src).toContain('song.mp3');
  });

  it('rejects if the element fires error before canplay', async () => {
    const { adapter, element } = setup();
    const promise = adapter.load(audioTrack);
    element.fireError(4, 'src not supported');
    await expect(promise).rejects.toThrow(/local:.*song\.mp3/);
  });
});

describe('LocalAdapter — guards before load', () => {
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

describe('LocalAdapter — play / pause', () => {
  it('calls element.play() on play()', async () => {
    const { adapter, element } = await setupLoaded();
    await adapter.play();
    expect(element.play).toHaveBeenCalledOnce();
  });

  it('calls element.pause() on pause()', async () => {
    const { adapter, element } = await setupLoaded();
    await adapter.pause();
    expect(element.pause).toHaveBeenCalledOnce();
  });
});

describe('LocalAdapter — seek', () => {
  it('converts ms to seconds for currentTime', async () => {
    const { adapter, element } = await setupLoaded();
    await adapter.seek(45_000);
    expect(element.currentTime).toBe(45);
  });

  it('uses adapter-reported duration for clamping (not metadata)', async () => {
    // Track metadata says 180s, but element reports 200s. Seeks beyond
    // 180 should still work (within element duration) without warning.
    const { adapter, element } = await setupLoaded(audioTrack, 200);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await adapter.seek(190_000);
    expect(element.currentTime).toBe(190);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clamps slight overruns silently (no warn)', async () => {
    const { adapter, element } = await setupLoaded(audioTrack, 180);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await adapter.seek(180_050);
    expect(element.currentTime).toBe(180);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clamps gross overruns and warns', async () => {
    const { adapter, element } = await setupLoaded(audioTrack, 180);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await adapter.seek(540_000);
    expect(element.currentTime).toBe(180);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('clamps negative values to 0', async () => {
    const { adapter, element } = await setupLoaded();
    await adapter.seek(-100);
    expect(element.currentTime).toBe(0);
  });
});

describe('LocalAdapter — setVolume', () => {
  it('clamps to [0, 1]', async () => {
    const { adapter, element } = await setupLoaded();
    await adapter.setVolume(0.5);
    expect(element.volume).toBe(0.5);

    await adapter.setVolume(-1);
    expect(element.volume).toBe(0);

    await adapter.setVolume(2);
    expect(element.volume).toBe(1);
  });
});

describe('LocalAdapter — events', () => {
  it('emits timeupdate in milliseconds', async () => {
    const { adapter, element } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('timeupdate', cb);
    element.fireTimeUpdate(12.5);
    expect(cb).toHaveBeenCalledWith(12_500);
  });

  it('emits ended', async () => {
    const { adapter, element } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('ended', cb);
    element.fireEnded();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('emits error wrapped with local: prefix', async () => {
    const { adapter, element } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('error', cb);
    element.fireError(3, 'decode broken');
    expect(cb).toHaveBeenCalledOnce();
    const err = cb.mock.calls[0]?.[0] as Error;
    expect(err.message).toMatch(/^local:/);
    expect(err.message).toContain('decode');
  });

  it('returns an unsubscribe handle that removes the listener', async () => {
    const { adapter, element } = await setupLoaded();
    const cb = vi.fn();
    const off = adapter.on('timeupdate', cb);
    element.fireTimeUpdate(1);
    off();
    element.fireTimeUpdate(2);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(1_000);
  });

  it('unsubscribe is safe to call twice', async () => {
    const { adapter } = await setupLoaded();
    const off = adapter.on('timeupdate', () => {});
    off();
    expect(() => off()).not.toThrow();
  });
});

describe('LocalAdapter — unload', () => {
  it('removes element listeners and resets to pre-load state', async () => {
    const { adapter, element } = await setupLoaded();
    const cb = vi.fn();
    adapter.on('timeupdate', cb);

    await adapter.unload();

    element.fireTimeUpdate(5);
    expect(cb).not.toHaveBeenCalled();

    await expect(adapter.play()).rejects.toThrow(/before load/);
  });

  it('is a no-op if called before any load', async () => {
    const { adapter } = setup();
    await expect(adapter.unload()).resolves.toBeUndefined();
  });
});

describe('LocalAdapter — getVisualElement', () => {
  it('returns null before load', () => {
    const { adapter } = setup();
    expect(adapter.getVisualElement()).toBeNull();
  });

  it('returns null for audio tracks', async () => {
    const { adapter } = await setupLoaded(audioTrack);
    expect(adapter.getVisualElement()).toBeNull();
  });

  it('returns the element for video tracks', async () => {
    const { adapter, element } = await setupLoaded(videoTrack);
    expect(adapter.getVisualElement()).toBe(element);
  });
});

describe('LocalAdapter — getPositionMs', () => {
  it('returns 0 before load', () => {
    const { adapter } = setup();
    expect(adapter.getPositionMs()).toBe(0);
  });

  it('returns currentTime in milliseconds', async () => {
    const { adapter, element } = await setupLoaded();
    element.currentTime = 30;
    expect(adapter.getPositionMs()).toBe(30_000);
  });
});

describe('LocalAdapter — getDurationMs', () => {
  it('returns 0 before load', () => {
    const { adapter } = setup();
    expect(adapter.getDurationMs()).toBe(0);
  });

  it('returns element.duration in milliseconds', async () => {
    const { adapter } = await setupLoaded(audioTrack, 214);
    expect(adapter.getDurationMs()).toBe(214_000);
  });

  it('returns 0 if element duration is NaN (pre-loadedmetadata)', () => {
    const { adapter, element } = setup();
    void adapter.load(audioTrack);
    expect(element.duration).toBeNaN();
    expect(adapter.getDurationMs()).toBe(0);
  });

  it('returns the adapter-reported duration even when it differs from metadata', async () => {
    const { adapter } = await setupLoaded(audioTrack, 214);
    expect(adapter.getDurationMs()).toBe(214_000);
  });

  it('reflects mid-playback duration revisions', async () => {
    // Chromium revising <audio>.duration after playback starts is the
    // case PlayerManager re-samples on each timeupdate to handle.
    const { adapter, element } = await setupLoaded(audioTrack, 192);
    expect(adapter.getDurationMs()).toBe(192_000);
    element.reviseDuration(214);
    expect(adapter.getDurationMs()).toBe(214_000);
  });
});
