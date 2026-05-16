import type { ReactElement } from 'react';
import type { Source } from '@renderer/core/types';
import styles from './SourceBadge.module.css';

const labels: Record<Source, string> = {
  local: 'LOCAL',
  youtube: 'YT',
  spotify: 'SPOTIFY',
};

type SourceBadgeProps = {
  readonly source: Source;
};

/**
 * Small uppercase pill identifying the source of the currently-playing
 * track. Lives in NowPlayingBar; can be reused on search result rows.
 */
export const SourceBadge = ({ source }: SourceBadgeProps): ReactElement => (
  <span className={styles.badge}>{labels[source]}</span>
);
