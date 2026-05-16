import type { ReactElement } from 'react';
import styles from './RingField.module.css';

type RingFieldProps = {
  readonly size?: number;
  readonly rings?: number;
};

/**
 * The concentric-ring motif. Reserved for splash, empty states, and
 * loading per the UI conventions. One reusable SVG
 * component; size and ring count are knobs, everything else is locked.
 */
export const RingField = ({
  size = 200,
  rings = 8,
}: RingFieldProps): ReactElement => {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 1; // leave 1px for the stroke

  return (
    <svg
      className={styles.field}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="presentation"
      aria-hidden
    >
      {Array.from({ length: rings }, (_, i) => {
        const r = maxR * ((i + 1) / rings);
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="var(--fg)"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
};
