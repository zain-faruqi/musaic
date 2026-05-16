import type { PlaybackAdapter, UnifiedTrack, Unsubscribe } from '@renderer/core/types';
import { isVideoFile } from '@renderer/core/file-types';
import { pathToLocalFileUrl } from './file-url';

type MediaKind = 'audio' | 'video';
type CreateElement = (kind: MediaKind) => HTMLMediaElement;

const defaultCreateElement: CreateElement = (kind) =>
  document.createElement(kind) as HTMLMediaElement;

type LocalAdapterOptions = {
  readonly createElement?: CreateElement;
};

/**
 * Adapter for local audio and video files. One instance owns one media
 * element and holds one track at a time.
 */
export class LocalAdapter implements PlaybackAdapter {
  readonly source = 'local' as const;

  readonly #createElement: CreateElement;

  #element: HTMLMediaElement | null = null;
  #kind: MediaKind | null = null;
  #loadedTrack: UnifiedTrack | null = null;

  readonly #timeupdateListeners = new Set<(ms: number) => void>();
  readonly #endedListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(err: Error) => void>();

  readonly #onElementTimeupdate = (): void => {
    if (!this.#element) return;
    const ms = this.#element.currentTime * 1000;
    for (const cb of this.#timeupdateListeners) cb(ms);
  };

  readonly #onElementEnded = (): void => {
    for (const cb of this.#endedListeners) cb();
  };

  readonly #onElementError = (): void => {
    const err = this.#wrapMediaError();
    for (const cb of this.#errorListeners) cb(err);
  };

  constructor(options: LocalAdapterOptions = {}) {
    this.#createElement = options.createElement ?? defaultCreateElement;
  }

  async load(track: UnifiedTrack): Promise<void> {
    if (track.source !== 'local') {
      throw new Error(`local: cannot load track from source '${track.source}'`);
    }

    if (this.#element) this.#detachElement();

    const kind: MediaKind = isVideoFile(track.sourceId) ? 'video' : 'audio';
    const element = this.#createElement(kind);
    element.preload = 'auto';
    element.src = pathToLocalFileUrl(track.sourceId);

    element.addEventListener('timeupdate', this.#onElementTimeupdate);
    element.addEventListener('ended', this.#onElementEnded);
    element.addEventListener('error', this.#onElementError);

    this.#element = element;
    this.#kind = kind;
    this.#loadedTrack = track;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        element.removeEventListener('canplay', onReady);
        element.removeEventListener('error', onErrorOnce);
      };
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onErrorOnce = (): void => {
        cleanup();
        reject(
          new Error(
            `local: load failed for ${track.sourceId}: ${this.#wrapMediaError().message}`,
          ),
        );
      };
      element.addEventListener('canplay', onReady);
      element.addEventListener('error', onErrorOnce);
    });
  }

  async play(): Promise<void> {
    if (!this.#element) throw new Error('local: play() called before load()');
    await this.#element.play();
  }

  async pause(): Promise<void> {
    if (!this.#element) throw new Error('local: pause() called before load()');
    this.#element.pause();
  }

  async seek(ms: number): Promise<void> {
    if (!this.#element || !this.#loadedTrack) {
      throw new Error('local: seek() called before load()');
    }
    // Use the adapter-reported duration (authoritative) rather than the
    // metadata-supplied one for clamping. They can disagree.
    const duration = this.getDurationMs() || this.#loadedTrack.durationMs;
    const clamped = Math.max(0, Math.min(ms, duration));

    if (duration > 0 && (ms < -duration || ms > duration * 2)) {
      console.warn(
        `local: seek(${ms}) clamped to ${clamped}; track duration ${duration}`,
      );
    }

    this.#element.currentTime = clamped / 1000;
  }

  async setVolume(v: number): Promise<void> {
    if (!this.#element) throw new Error('local: setVolume() called before load()');
    this.#element.volume = Math.max(0, Math.min(1, v));
  }

  async unload(): Promise<void> {
    if (!this.#element) return;
    this.#detachElement();
    this.#loadedTrack = null;
    this.#kind = null;
    this.#timeupdateListeners.clear();
    this.#endedListeners.clear();
    this.#errorListeners.clear();
  }

  getPositionMs(): number {
    return this.#element ? this.#element.currentTime * 1000 : 0;
  }

  getDurationMs(): number {
    if (!this.#element) return 0;
    const d = this.#element.duration;
    if (!Number.isFinite(d) || d <= 0) return 0;
    return d * 1000;
  }

  getVisualElement(): HTMLElement | null {
    if (this.#kind !== 'video' || !this.#element) return null;
    return this.#element as HTMLVideoElement;
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
        throw new Error(`local: unknown event ${String(_exhaustive)}`);
      }
    }
  }

  #detachElement(): void {
    if (!this.#element) return;
    const el = this.#element;
    el.removeEventListener('timeupdate', this.#onElementTimeupdate);
    el.removeEventListener('ended', this.#onElementEnded);
    el.removeEventListener('error', this.#onElementError);
    el.pause();
    el.removeAttribute('src');
    el.load();
    this.#element = null;
  }

  #wrapMediaError(): Error {
    const err = this.#element?.error;
    if (!err) return new Error('local: unknown media error');
    const codeName =
      ({ 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src not supported' } as const)[
        err.code as 1 | 2 | 3 | 4
      ] ?? 'unknown';
    const detail = err.message ? ': ' + err.message : '';
    return new Error(`local: media error (${codeName}, code ${err.code})${detail}`);
  }
}
