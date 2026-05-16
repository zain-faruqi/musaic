import type { ReactElement } from 'react';
import type { PlaybackError, UnifiedTrack } from '@renderer/core/types';
import { Tile } from '../components/Tile';
import { TransportControls } from '../components/TransportControls';
import { SourceBadge } from '../components/SourceBadge';
import { Scrubber } from '../components/Scrubber';
import { PositionDisplay } from '../components/PositionDisplay';
import styles from './NowPlayingBar.module.css';

type NowPlayingBarProps = {
  readonly track: UnifiedTrack | null;
  readonly isPlaying?: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrev?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  /**
   * Structured playback failure for the current track, or null when
   * playback is fine. When non-null, the center column swaps from
   * transport/scrubber to an error affordance (message + button).
   */
  readonly playbackError?: PlaybackError | null;
  /** Called by the "open externally" button for embed-disallowed errors. */
  readonly onOpenExternal?: ((url: string) => void) | undefined;
  /** Called by the "dismiss" button for not-found / unknown errors. */
  readonly onDismissError?: (() => void) | undefined;
};

/**
 * Resolve the user-facing message + button shape for a playback
 * error. Centralized so the JSX below stays flat.
 *
 * `source` is threaded through because the open-externally button
 * label is per-source ("open on youtube" vs "open on spotify"); the
 * underlying URL is in `err.watchUrl` regardless. Spotify
 * contributes four additional reasons:
 *
 *   - 'region-locked'      — playable elsewhere, just not for this
 *                            user's region. Open-externally helps:
 *                            Spotify's site handles the region check
 *                            with its own affordances (Premium prompt,
 *                            country switcher).
 *   - 'premium-required'   — explicit upsell. Open-externally lets
 *                            the user upgrade or play in-browser
 *                            with their free tier (which gets ads
 *                            but is not blocked).
 *   - 'content-removed'    — Spotify equivalent of YouTube's
 *                            'not-found'. Dead-end; dismiss.
 *   - 'auth-required'      — token revoked. The user has to
 *                            reconnect in Settings → Connections.
 *                            We surface this with `dismiss`; the
 *                            inline message tells them where to go.
 *                            Not open-externally because the right
 *                            destination is *our* connections row,
 *                            not Spotify's site.
 */
const errorRenderInfo = (
  err: PlaybackError,
  source: UnifiedTrack['source'] | null,
): {
  readonly message: string;
  readonly action: 'open-external' | 'dismiss';
  readonly openButtonLabel?: string;
} => {
  // Pick the per-source open-external label once. Used by all
  // reasons whose action is 'open-external'.
  const openLabel =
    source === 'spotify' ? 'open on spotify' : 'open on youtube';

  switch (err.reason) {
    // YouTube reasons.
    case 'embed-disallowed':
      return {
        message: "this video can't be embedded — open on youtube",
        action: 'open-external',
        openButtonLabel: openLabel,
      };
    case 'not-found':
      return {
        message: 'this video is no longer available',
        action: 'dismiss',
      };
    // Spotify reasons.
    case 'region-locked':
      return {
        message: 'not available in your region',
        action: 'open-external',
        openButtonLabel: openLabel,
      };
    case 'premium-required':
      return {
        message: 'Spotify Premium required to play',
        action: 'open-external',
        openButtonLabel: openLabel,
      };
    case 'content-removed':
      return {
        message: 'this track has been removed from Spotify',
        action: 'dismiss',
      };
    case 'auth-required':
      return {
        message: 'reconnect Spotify in settings to play',
        action: 'dismiss',
      };
    // Generic fallback.
    case 'unknown':
      return {
        message: 'playback failed',
        action: 'dismiss',
      };
  }
};

/**
 * Always-mounted now-playing bar. Three-column grid:
 *   left  — artwork tile + title/subtitle
 *   center — transport on top, scrubber + position readouts below
 *           (replaced by an error affordance when playbackError is set)
 *   right — source badge
 *
 * Scrubber and PositionDisplay subscribe to the store directly, so this
 * component only re-renders on track change / play-pause flips / error
 * transitions. The timeupdate firehose stays scoped to the children
 * that actually care.
 */
export const NowPlayingBar = ({
  track,
  isPlaying = false,
  onPlayPause,
  onPrev,
  onNext,
  playbackError = null,
  onOpenExternal,
  onDismissError,
}: NowPlayingBarProps): ReactElement => {
  const subtitle = track
    ? track.album
      ? `${track.artists.join(', ')} — ${track.album}`
      : track.artists.join(', ')
    : '';

  const renderCenter = (): ReactElement => {
    if (playbackError !== null) {
      const info = errorRenderInfo(playbackError, track?.source ?? null);
      return (
        <div className={styles.errorRow} role="alert">
          <span className={styles.errorMessage}>{info.message}</span>
          {info.action === 'open-external' ? (
            <button
              type="button"
              className={styles.errorButton}
              onClick={() => {
                if (playbackError.watchUrl !== undefined && onOpenExternal) {
                  onOpenExternal(playbackError.watchUrl);
                }
              }}
              disabled={playbackError.watchUrl === undefined}
            >
              {info.openButtonLabel}
            </button>
          ) : (
            <button
              type="button"
              className={styles.errorButton}
              onClick={onDismissError}
            >
              dismiss
            </button>
          )}
        </div>
      );
    }
    return (
      <>
        <div className={styles.transportRow}>
          <TransportControls
            isPlaying={isPlaying}
            disabled={!track}
            onPlayPause={onPlayPause}
            onPrev={onPrev}
            onNext={onNext}
          />
        </div>
        <div className={styles.scrubRow}>
          <PositionDisplay source="position" />
          <Scrubber />
          <PositionDisplay source="duration" />
        </div>
      </>
    );
  };

  return (
    <footer className={styles.bar}>
      <div className={styles.left}>
        <Tile
          size={56}
          ariaLabel={track ? `Artwork for ${track.title}` : 'No track loaded'}
          {...(track?.artwork !== undefined && { artworkUrl: track.artwork })}
        />
        <div className={styles.text}>
          <div className={styles.title}>{track?.title ?? ''}</div>
          <div className={styles.subtitle}>{subtitle}</div>
        </div>
      </div>

      <div className={styles.center}>{renderCenter()}</div>

      <div className={styles.right}>{track ? <SourceBadge source={track.source} /> : null}</div>
    </footer>
  );
};
