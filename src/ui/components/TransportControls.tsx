import type { ReactElement } from 'react';
import { PlayIcon, PauseIcon, PrevIcon, NextIcon } from './Icon';
import styles from './TransportControls.module.css';

type TransportControlsProps = {
  readonly isPlaying: boolean;
  readonly disabled?: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrev?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
};

/**
 * Prev / play-pause / next button group. Pure presentational — handlers
 * come from outside. PlayerManager wires these via the global store
 * once it lands.
 */
export const TransportControls = ({
  isPlaying,
  disabled = false,
  onPlayPause,
  onPrev,
  onNext,
}: TransportControlsProps): ReactElement => (
  <div className={styles.controls}>
    <button
      type="button"
      className={styles.button}
      disabled={disabled}
      onClick={onPrev}
      aria-label="Previous track"
    >
      <PrevIcon />
    </button>
    <button
      type="button"
      className={styles.button}
      disabled={disabled}
      onClick={onPlayPause}
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? <PauseIcon /> : <PlayIcon />}
    </button>
    <button
      type="button"
      className={styles.button}
      disabled={disabled}
      onClick={onNext}
      aria-label="Next track"
    >
      <NextIcon />
    </button>
  </div>
);
