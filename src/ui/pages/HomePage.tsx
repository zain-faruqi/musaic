import type { ReactElement } from 'react';
import type { UnifiedTrack } from '@renderer/core/types';
import { NewPlaylistPill } from '../components/NewPlaylistPill';
import { PlaylistTile } from '../components/PlaylistTile';
import { RingField } from '../components/RingField';
import { Tile } from '../components/Tile';
import { YouTubeUrlInput } from '../components/YouTubeUrlInput';
import { SpotifyUrlInput } from '../components/SpotifyUrlInput';
import { pickAndPlay } from '@renderer/state/library';
import { useLibraryStore } from '@renderer/state/library-store';
import { usePlayerStore } from '@renderer/state/player-store';
import { usePlaylistStore } from '@renderer/state/playlist-store';
import styles from './HomePage.module.css';

const TILE_SIZE = 160;

/**
 * Home view, post-watcher landing. One `/ Recently Added` row of
 * tiles sourced from `library:list`. Clicking a tile loads the full
 * library list as the queue, with the cursor on the clicked track,
 * and autoplays — same shape as Spotify/Apple's "play from album view"
 * behavior. The full list (not just the one track) is the queue so
 * that the user can hit next/previous and the cross-source navigation
 * primitives keep working as more sources are added.
 *
 * The `open file` pill is retained as a secondary action: the
 * documented fallback for adding a one-off file from outside the
 * Musaic folder.
 *
 * Empty state shows the concentric-ring motif and a one-line helper —
 * same shape as before, just gated on the library being empty rather
 * than on "no demo flow yet."
 *
 * No `/ Connections` section on either branch (empty or
 * populated). The Spotify auth widget lives in the navbar instead,
 * visible on every page rather than just here.
 */
export const HomePage = (): ReactElement => {
  const tracks = useLibraryStore((s) => s.tracks);
  const loading = useLibraryStore((s) => s.loading);
  const setQueue = usePlayerStore((s) => s.actions.setQueue);
  const playlists = usePlaylistStore((s) => s.playlists);

  const onPick = (): void => {
    pickAndPlay().catch((err: unknown) => {
      console.error('HomePage: pickAndPlay failed', err);
    });
  };

  // Loading and empty share a layout; we just swap the helper text.
  // Both render the open-file pill at the bottom — without it the
  // empty state would be a dead end for a fresh install. The
  // YouTube URL input sits alongside it.
  if (tracks.length === 0) {
    return (
      <div className={styles.page}>
        {playlists.length > 0 ? (
          // Library is empty but playlists exist (e.g. user deleted
          // their local files but their playlist rows remain). Keep
          // the section visible so the user can still navigate to
          // them; the centered empty-state block below sits beneath.
          // Fresh-install (no tracks, no playlists) skips the section
          // entirely so the empty state stays focused on the ring
          // motif and onboarding affordances.
          <section className={styles.section}>
            <header className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>/ Playlists</h2>
              <div className={styles.sectionActions}>
                <NewPlaylistPill />
              </div>
            </header>
            <div className={styles.row} role="list">
              {playlists.map((p) => (
                <PlaylistTile key={p.id} playlist={p} />
              ))}
            </div>
          </section>
        ) : null}
        <div className={styles.empty}>
          <RingField size={240} rings={10} />
          <p className={styles.helper}>
            {loading ? 'loading your library' : 'your library will appear here'}
          </p>
          <button type="button" className={styles.pickButton} onClick={onPick}>
            open file
          </button>
          <YouTubeUrlInput />
          <SpotifyUrlInput />
        </div>
      </div>
    );
  }

  const onTileClick = (index: number): void => {
    setQueue(tracks, { cursor: index, autoplay: true });
  };

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>/ Playlists</h2>
          <div className={styles.sectionActions}>
            <NewPlaylistPill />
          </div>
        </header>
        {playlists.length > 0 ? (
          <div className={styles.row} role="list">
            {playlists.map((p) => (
              <PlaylistTile key={p.id} playlist={p} />
            ))}
          </div>
        ) : null}
      </section>
      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>/ Recently Added</h2>
          <div className={styles.sectionActions}>
            <YouTubeUrlInput />
            <SpotifyUrlInput />
            <button
              type="button"
              className={styles.pickButtonInline}
              onClick={onPick}
            >
              open file
            </button>
          </div>
        </header>
        <div className={styles.row} role="list">
          {tracks.map((track, i) => (
            <TrackTile
              key={track.id}
              track={track}
              onClick={() => {
                onTileClick(i);
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
};

type TrackTileProps = {
  readonly track: UnifiedTrack;
  readonly onClick: () => void;
};

/**
 * One tile + title/subtitle, click anywhere on the card to start
 * playing. The whole card is a button so the focus target matches
 * the visual affordance (one big click region, one tab stop).
 *
 * Defined in the same file because it's only used here. If a second
 * page needs it, lift to ui/components/.
 */
const TrackTile = ({ track, onClick }: TrackTileProps): ReactElement => {
  const subtitle = track.artists.length > 0 ? track.artists.join(', ') : '';
  return (
    <button
      type="button"
      className={styles.tileCard}
      onClick={onClick}
      role="listitem"
      aria-label={`Play ${track.title}${subtitle ? ` by ${subtitle}` : ''}`}
    >
      <Tile
        size={TILE_SIZE}
        ariaLabel={`Artwork for ${track.title}`}
        {...(track.artwork !== undefined && { artworkUrl: track.artwork })}
      />
      <div className={styles.tileMeta}>
        <div className={styles.tileTitle}>{track.title}</div>
        <div className={styles.tileSubtitle}>{subtitle}</div>
      </div>
    </button>
  );
};
