import type { ReactElement, ReactNode } from 'react';
import { TopBar } from './TopBar';
import { NowPlayingBar } from './NowPlayingBar';
import { VideoPanel } from './VideoPanel';
import { usePlayerStore } from '@renderer/state/player-store';
import styles from './AppShell.module.css';

type AppShellProps = {
  readonly children: ReactNode;
};

/**
 * Top-level layout: TopBar / VideoPanel / scrollable content / NowPlayingBar.
 * All chrome (TopBar, VideoPanel, NowPlayingBar) is always mounted; the
 * content slot swaps pages. VideoPanel collapses via CSS when no current
 * adapter has a visual element — it's never unmounted, because
 * reparenting a live `<iframe>` reloads its content).
 *
 * Subscribes to the player store with one selector per slice. Each
 * selector independently triggers re-render only when its value
 * changes — so this component re-renders on track change, play/pause,
 * and error transitions, but not on every position update (those flow
 * into NowPlayingBar via the same store, but only the scrubber slot
 * cares).
 */
export const AppShell = ({ children }: AppShellProps): ReactElement => {
  const track = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.playbackState === 'playing');
  const playbackError = usePlayerStore((s) => s.playbackError);
  const actions = usePlayerStore((s) => s.actions);

  // The open-external IPC bridge isn't part of player-store; it's a
  // standalone system action. Defined inline because there's only one
  // caller (NowPlayingBar for embed-disallowed) and threading a
  // dedicated module for one one-line IPC call would be ceremony.
  const onOpenExternal = (url: string): void => {
    window.musaic.system.openExternal({ url }).catch((err: unknown) => {
      // The allowlist may reject, or shell.openExternal may fail (very
      // rare on macOS). Log; the user-facing affordance has done its
      // job by trying.
      console.error('AppShell: openExternal failed', err);
    });
  };

  return (
    <div className={styles.shell}>
      <TopBar />
      <VideoPanel />
      <main className={styles.content}>{children}</main>
      <NowPlayingBar
        track={track}
        isPlaying={isPlaying}
        onPlayPause={actions.togglePlayPause}
        onNext={actions.next}
        onPrev={actions.previous}
        playbackError={playbackError}
        onOpenExternal={onOpenExternal}
        onDismissError={actions.dismissPlaybackError}
      />
    </div>
  );
};
