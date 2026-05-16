import { useCallback, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { usePlayerStore } from '@renderer/state/player-store';
import styles from './Scrubber.module.css';

/**
 * Click + drag progress bar. Subscribes directly to position and
 * duration so its parent (NowPlayingBar) doesn't re-render every
 * timeupdate.
 *
 * During drag, the visual reflects local component state rather than
 * the live position — position is sampled, not commanded. On
 * pointer up, the dragged value is committed via
 * `seek()` and the component goes back to mirroring whatever the
 * adapter reports.
 */
export const Scrubber = (): ReactElement => {
  const positionMs = usePlayerStore((s) => s.positionMs);
  const durationMs = usePlayerStore((s) => s.current?.durationMs ?? 0);
  const seek = usePlayerStore((s) => s.actions.seek);

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragMs, setDragMs] = useState<number | null>(null);

  const isDragging = dragMs !== null;
  const hasDuration = durationMs > 0;
  const displayMs = isDragging ? dragMs : positionMs;
  const pct = hasDuration ? Math.max(0, Math.min(100, (displayMs / durationMs) * 100)) : 0;

  const msFromPointer = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const clamped = Math.max(0, Math.min(1, ratio));
      return clamped * durationMs;
    },
    [durationMs],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!hasDuration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragMs(msFromPointer(e.clientX));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!isDragging) return;
    setDragMs(msFromPointer(e.clientX));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!isDragging) return;
    const finalMs = msFromPointer(e.clientX);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragMs(null);
    seek(finalMs);
  };

  return (
    <div
      ref={trackRef}
      className={hasDuration ? styles.scrubber : styles.scrubberDisabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs)}
      aria-valuenow={Math.round(displayMs)}
    >
      <div className={styles.track}>
        <div className={styles.progress} style={{ inlineSize: `${pct}%` }} />
      </div>
    </div>
  );
};
