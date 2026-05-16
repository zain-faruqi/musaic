import type { ReactElement } from 'react';
import { usePlayerStore } from '@renderer/state/player-store';
import styles from './PositionDisplay.module.css';

type PositionDisplayProps = {
  /** Which value to render: live position, or the loaded track's duration. */
  readonly source: 'position' | 'duration';
};

/**
 * Format milliseconds as `m:ss`, or `h:mm:ss` for tracks at least 1 hour.
 * Negative values clamp to 0; sub-second precision is dropped.
 */
const formatMs = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
};

/**
 * Time readout. Subscribes only to the slice it needs so it re-renders
 * on timeupdate without dragging its parent along.
 */
export const PositionDisplay = ({ source }: PositionDisplayProps): ReactElement => {
  const ms = usePlayerStore((s) =>
    source === 'position' ? s.positionMs : s.current?.durationMs ?? 0,
  );
  return <span className={styles.display}>{formatMs(ms)}</span>;
};
