import type { ReactElement, ReactNode } from 'react';
import styles from './Tile.module.css';

type TileProps = {
  readonly size?: number;
  /**
   * Optional remote (or local-data) image URL to render inside the
   * tile. When provided, the tile renders an `<img>` over the
   * stroke-first placeholder; when null/undefined, the placeholder
   * stays.
   *
   * Loaded lazily so a long list of off-screen tiles doesn't burn
   * bandwidth at page-load. `decoding="async"` keeps a slow decode
   * off the main thread.
   *
   * CSP `img-src` constrains which hosts are allowed (see
   * src/index.html). YouTube thumbnails (`*.ytimg.com`) are
   * allowlisted; arbitrary user-supplied URLs that don't match the
   * allowlist will fail to load — by design.
   */
  readonly artworkUrl?: string;
  /** Content rendered inside the tile (overrides artworkUrl). */
  readonly children?: ReactNode;
  readonly ariaLabel?: string;
};

/**
 * Square stroke-first placeholder. Album art slots, video thumbnails,
 * and avatars all start as a Tile until real content loads.
 * UI conventions: tiles are square, sharp corners,
 * 1px white stroke on black.
 *
 * Render order: explicit `children` > `artworkUrl` > bare placeholder.
 */
export const Tile = ({
  size = 56,
  artworkUrl,
  children,
  ariaLabel,
}: TileProps): ReactElement => {
  const content = children ?? (
    artworkUrl !== undefined ? (
      <img
        src={artworkUrl}
        // The tile already carries the accessible label via aria-label;
        // the image itself is decorative so `alt=""` is correct.
        alt=""
        loading="lazy"
        decoding="async"
      />
    ) : null
  );
  return (
    <div
      className={styles.tile}
      style={{ width: size, height: size }}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    >
      {content}
    </div>
  );
};
