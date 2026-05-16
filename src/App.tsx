import type { ReactElement } from 'react';
import { useUIStore } from './state/ui-store';
import { AppShell } from './ui/layout/AppShell';
import { AddTracksToPlaylistPage } from './ui/pages/AddTracksToPlaylistPage';
import { HomePage } from './ui/pages/HomePage';
import { PlaylistDetailPage } from './ui/pages/PlaylistDetailPage';

/**
 * Top-level view switch.
 *
 * v1 routing is a discriminated-union state in `ui-store`; no
 * react-router. The switch here is exhaustive over the View kinds —
 * `content` is declared without an initializer so adding a new view
 * variant produces a compile-time "used before assigned" error rather
 * than a silent fallthrough.
 */
export const App = (): ReactElement => {
  const view = useUIStore((s) => s.currentView);

  let content: ReactElement;
  switch (view.kind) {
    case 'home':
      content = <HomePage />;
      break;
    case 'playlist':
      content = <PlaylistDetailPage id={view.id} />;
      break;
    case 'add-tracks':
      content = <AddTracksToPlaylistPage playlistId={view.playlistId} />;
      break;
  }

  return <AppShell>{content}</AppShell>;
};
