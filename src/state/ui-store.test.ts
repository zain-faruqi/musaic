/**
 * Tests for the ui-store view router.
 *
 * Tiny surface: a discriminated-union state plus a `navigate`
 * action. The test seam is the store itself — Zustand stores
 * can be read and dispatched against in unit tests directly.
 *
 * The store is module-scoped so tests reset between cases via
 * the `navigate` action (idempotent: navigate(home) brings us
 * back regardless of prior state).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useUIStore } from './ui-store';

describe('ui-store', () => {
  afterEach(() => {
    // Reset to home between tests; the store is shared module
    // state and we don't want cases bleeding into each other.
    useUIStore.getState().actions.navigate({ kind: 'home' });
  });

  it('defaults to home', () => {
    expect(useUIStore.getState().currentView).toEqual({ kind: 'home' });
  });

  it('navigates to a playlist with id', () => {
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 42 });
    expect(useUIStore.getState().currentView).toEqual({
      kind: 'playlist',
      id: 42,
    });
  });

  it('navigates to add-tracks with a playlistId', () => {
    useUIStore.getState().actions.navigate({
      kind: 'add-tracks',
      playlistId: 7,
    });
    expect(useUIStore.getState().currentView).toEqual({
      kind: 'add-tracks',
      playlistId: 7,
    });
  });

  it('round-trips playlist → add-tracks → playlist', () => {
    const { navigate } = useUIStore.getState().actions;
    navigate({ kind: 'playlist', id: 3 });
    navigate({ kind: 'add-tracks', playlistId: 3 });
    expect(useUIStore.getState().currentView).toEqual({
      kind: 'add-tracks',
      playlistId: 3,
    });
    navigate({ kind: 'playlist', id: 3 });
    expect(useUIStore.getState().currentView).toEqual({
      kind: 'playlist',
      id: 3,
    });
  });

  it('navigates back to home', () => {
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 1 });
    useUIStore.getState().actions.navigate({ kind: 'home' });
    expect(useUIStore.getState().currentView).toEqual({ kind: 'home' });
  });

  it('navigates from add-tracks back to home', () => {
    useUIStore.getState().actions.navigate({
      kind: 'add-tracks',
      playlistId: 9,
    });
    useUIStore.getState().actions.navigate({ kind: 'home' });
    expect(useUIStore.getState().currentView).toEqual({ kind: 'home' });
  });

  it('navigation notifies subscribers', () => {
    const seen: ReadonlyArray<{ kind: string; id?: number }>[] = [];
    const unsubscribe = useUIStore.subscribe((state) => {
      const v = state.currentView;
      switch (v.kind) {
        case 'home':
          seen.push([{ kind: 'home' }]);
          break;
        case 'playlist':
          seen.push([{ kind: 'playlist', id: v.id }]);
          break;
        case 'add-tracks':
          seen.push([{ kind: 'add-tracks', id: v.playlistId }]);
          break;
      }
    });
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 1 });
    useUIStore
      .getState()
      .actions.navigate({ kind: 'add-tracks', playlistId: 1 });
    useUIStore.getState().actions.navigate({ kind: 'home' });
    unsubscribe();
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });
});
