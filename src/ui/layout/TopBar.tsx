import type { ReactElement } from 'react';
import { SpotifyAuthWidget } from '../components/SpotifyAuthWidget';
import styles from './TopBar.module.css';

/**
 * Always-mounted top bar. Wordmark left, auth widget right.
 * The bar itself is draggable (macOS hiddenInset titlebar mode); the
 * widget's buttons opt out via `-webkit-app-region: no-drag` in
 * their CSS module so clicks register as clicks rather than
 * initiating a window drag.
 *
 * The 84px left padding clears the macOS traffic lights that float in
 * the top-left of a hiddenInset window.
 *
 * The decorative Library / NowPlaying / Profile icon group was
 * removed — those buttons were placeholders pointing at no
 * routes, and they competed visually with the auth widget that
 * relocated here. The auth widget now lives in the slot the icon
 * group used to occupy. The icon components themselves remain in
 * components/Icon.tsx for potential future reuse (cheap to keep,
 * disruptive to delete and re-add).
 */
export const TopBar = (): ReactElement => (
  <header className={styles.bar}>
    <h1 className={styles.wordmark}>MUSAIC</h1>
    <div className={styles.spacer} />
    <div className={styles.widgetSlot}>
      <SpotifyAuthWidget />
    </div>
  </header>
);

