import type { ReactElement } from 'react';
import { useSpotifyStore } from '@renderer/state/spotify-store';
import styles from './SpotifyAuthWidget.module.css';

/**
 * Spotify auth widget — lives in the navbar (top bar).
 * Renders the Spotify pill button and its various states off the
 * spotify-store. Apple Music (post-v1) and any other source-with-OAuth
 * slot in alongside as siblings within the navbar.
 *
 * The widget mounts in the navbar; HomePage no longer has a
 * `/ Connections` section (the widget was its sole content and its
 * placement-in-flow had
 * the property that, once the user connected once, the section read
 * as dead weight on every subsequent page load). The navbar puts the
 * affordance at-hand on every page and doesn't take vertical space
 * away from the library.
 *
 * State → UI mapping (unchanged from 4c):
 *   - 'disconnected'  → "Connect Spotify" pill
 *   - 'connecting'    → "Connecting…" pill, disabled
 *   - 'connected'     → "Spotify — <email>" + inline Disconnect action
 *   - 'error'         → "Connect Spotify" + error sub-line under it
 *
 * Buttons opt out of the BrowserWindow drag region via
 * `-webkit-app-region: no-drag` (applied in the CSS module), because
 * the navbar's root sets `app-region: drag` to make the bar draggable
 * — without the opt-out, clicks on the pill would drag the window
 * rather than fire the connect handler.
 *
 * No tests for this component — the behavioral coverage lives in
 * spotify-store and the IPC layer below it. This is just a switch on
 * state plus event handlers.
 */
export const SpotifyAuthWidget = (): ReactElement => {
  const status = useSpotifyStore((s) => s.status);
  const connect = useSpotifyStore((s) => s.actions.connect);
  const disconnect = useSpotifyStore((s) => s.actions.disconnect);

  const onConnect = (): void => {
    // Fire-and-forget — the store handles in-flight state and any
    // thrown error internally; the click site doesn't need to await.
    connect().catch((err: unknown) => {
      console.error('SpotifyAuthWidget: connect failed', err);
    });
  };

  const onDisconnect = (): void => {
    disconnect().catch((err: unknown) => {
      console.error('SpotifyAuthWidget: disconnect failed', err);
    });
  };

  switch (status.kind) {
    case 'disconnected':
      return (
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={onConnect}>
            Connect Spotify
          </button>
        </div>
      );
    case 'connecting':
      return (
        <div className={styles.row}>
          <button type="button" className={styles.button} disabled>
            Connecting…
          </button>
        </div>
      );
    case 'connected':
      return (
        <div className={styles.row}>
          <div className={styles.connectedRow}>
            <span className={styles.connectedLabel}>
              Spotify — {status.email}
            </span>
            <button
              type="button"
              className={styles.disconnectAction}
              onClick={onDisconnect}
              aria-label="Disconnect Spotify"
            >
              Disconnect
            </button>
          </div>
        </div>
      );
    case 'error':
      return (
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={onConnect}>
            Connect Spotify
          </button>
          <span className={styles.errorMessage} role="alert">
            {status.message}
          </span>
        </div>
      );
  }
};
