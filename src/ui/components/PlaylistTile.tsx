import type { ReactElement } from 'react';
import type { PlaylistSummary } from '@ipc/contracts';
import { useUIStore } from '@renderer/state/ui-store';
import { Tile } from './Tile';
import styles from './PlaylistTile.module.css';

const TILE_SIZE = 160;

type PlaylistTileProps = {
  readonly playlist: PlaylistSummary;
};

/**
 * A tile-card for a playlist on the HomePage `/ Playlists` row.
 *
 * Uses the existing `<Tile>` in stroke-placeholder mode — composite
 * 4-up artwork is explicitly out of scope for this slice. The tile
 * is wrapped in a button so the whole card is the click target;
 * clicking navigates to the detail view.
 *
 * Subtitle is "N tracks" via the playlist's pre-fetched trackCount
 * (so the UI doesn't have to query the join table per tile).
 * Singular/plural handled inline.
 */
export const PlaylistTile = ({
  playlist,
}: PlaylistTileProps): ReactElement => {
  const navigate = useUIStore((s) => s.actions.navigate);

  const subtitle =
    playlist.trackCount === 1
      ? '1 track'
      : `${playlist.trackCount} tracks`;

  const onClick = (): void => {
    navigate({ kind: 'playlist', id: playlist.id });
  };

  return (
    <button
      type="button"
      className={styles.card}
      onClick={onClick}
      role="listitem"
      aria-label={`Open playlist ${playlist.name}`}
    >
      <Tile
        size={TILE_SIZE}
        ariaLabel={`Cover for ${playlist.name}`}
      />
      <div className={styles.meta}>
        <div className={styles.title}>{playlist.name}</div>
        <div className={styles.subtitle}>{subtitle}</div>
      </div>
    </button>
  );
};
