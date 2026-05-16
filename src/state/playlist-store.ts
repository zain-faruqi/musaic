/**
 * Renderer-side mirror of the local-playlist state.
 *
 * Two concerns in one store:
 *   - `playlists`: list view (PlaylistSummary[]). Refreshes on
 *     module-init and on every `playlist:changed` signal.
 *   - `currentPlaylistDetail`: detail view payload. Loaded when
 *     `ui-store.currentView` is `{ kind: 'playlist', id }`;
 *     refreshed on `playlist:changed` if a detail is currently
 *     loaded; cleared when the view goes back to home.
 *
 * The detail-view sync uses Zustand's `subscribe` on `ui-store`
 * rather than React's `useEffect` — matches the project's "no
 * useEffect for derived state" rule. The subscription lives at
 * module init for the lifetime of the renderer.
 *
 * Test seam: `subscribeToChanges` is gated on `window.musaic`
 * being present, mirroring `library-store.ts` exactly. Tests
 * import the store and verify the action surface; the
 * subscription itself isn't exercised in tests.
 */
import { create } from 'zustand';
import type { PlaylistDetail, PlaylistSummary } from '@ipc/contracts';
import {
  addTracksToPlaylist as addTracksToPlaylistIpc,
  createPlaylist as createPlaylistIpc,
  deletePlaylist as deletePlaylistIpc,
  getPlaylist as getPlaylistIpc,
  listPlaylists as listPlaylistsIpc,
  removeTracksFromPlaylist as removeTracksFromPlaylistIpc,
  renamePlaylist as renamePlaylistIpc,
  reorderPlaylist as reorderPlaylistIpc,
} from './playlists';
import { useUIStore, type View } from './ui-store';

type PlaylistState = {
  /** Every playlist in summary form, ordered most-recently-touched first. */
  readonly playlists: readonly PlaylistSummary[];
  /** Whether the very first list fetch is in flight. */
  readonly loading: boolean;
  /** Latest list-fetch error, if any. */
  readonly error: string | null;

  /**
   * The currently-viewed playlist detail, or null when no detail
   * view is active. Updated by the `ui-store` subscription below
   * and refreshed on each `playlist:changed` signal while loaded.
   */
  readonly currentPlaylistDetail: PlaylistDetail | null;
  /** True while a `loadDetail` is in flight. */
  readonly detailLoading: boolean;

  /**
   * Transient error from the most recent `reorderTracks` action,
   * scoped to a single playlist id. Null at rest. Set by the action
   * on IPC failure (after the optimistic snapshot has been rolled
   * back), auto-cleared after `REORDER_ERROR_LINGER_MS`. The detail
   * page renders it inline above the tile row when the id matches
   * the page's id.
   *
   * Shape note: `{ playlistId, message } | null` is the discriminated
   * presence shape preferred over a separate boolean flag — `null`
   * means "no error" unambiguously; the `playlistId` scopes the
   * message to the right detail view in case the user navigated
   * between the dispatch and the failure.
   */
  readonly reorderError: { readonly playlistId: number; readonly message: string } | null;

  readonly actions: {
    refreshList(): Promise<void>;
    loadDetail(id: number): Promise<void>;
    clearDetail(): void;
    /**
     * Create a playlist by name. Returns the IPC's discriminated
     * result so the caller can render inline validation messages.
     * Does not optimistically update; the `playlist:changed`
     * broadcast triggers the refresh.
     */
    create(
      name: string,
    ): ReturnType<typeof createPlaylistIpc>;
    rename(
      id: number,
      name: string,
    ): ReturnType<typeof renamePlaylistIpc>;
    delete(id: number): Promise<void>;
    /**
     * Append tracks to a playlist.
     *
     * Thin wrapper around `addTracksToPlaylist`; no optimistic update —
     * the `playlist:changed` broadcast refreshes the list and detail.
     * Returns `{ added, skipped }` so the picker can inline-surface
     * the partial-success count.
     */
    addTracks(
      id: number,
      tracks: readonly { readonly source: 'local' | 'youtube' | 'spotify'; readonly sourceId: string }[],
    ): ReturnType<typeof addTracksToPlaylistIpc>;
    /**
     * Remove tracks from a playlist by their surrogate
     * `playlistTrackId`s. Same refresh-on-signal pattern
     * as `addTracks`. Returns `{ removed }` for parity with the IPC
     * contract; the per-tile remove × in PlaylistDetailPage ignores
     * the count and lets the broadcast refresh handle the UI.
     */
    removeTracks(
      id: number,
      playlistTrackIds: readonly number[],
    ): ReturnType<typeof removeTracksFromPlaylistIpc>;
    /**
     * Reorder a playlist's tracks.
     *
     * Departs from the rest of the surface: this is the project's
     * one optimistic update. Drag-and-drop's UX expectation is that
     * the tile lands where dropped, immediately. A pure signal-driven
     * refresh would snap-back-then-reorder on every drop (a visible
     * flicker), so we mutate the renderer's `currentPlaylistDetail`
     * synchronously, dispatch IPC, and either let the broadcast
     * confirm (no-op) or roll back on failure.
     *
     * The optimistic step runs only when the dispatched id matches
     * the id currently in scope (either `playlist:N` or
     * `add-tracks:N`, via `playlistIdInScope`). Off-scope dispatches
     * skip straight to the IPC call.
     *
     * On failure: snapshot is restored AND `reorderError` is set
     * with the playlistId and a short message. The error auto-clears
     * after `REORDER_ERROR_LINGER_MS`. The detail page reads
     * `reorderError` and renders it inline when its id matches.
     */
    reorderTracks(
      playlistId: number,
      orderedPlaylistTrackIds: readonly number[],
    ): Promise<void>;
    /**
     * Imperative reset for the transient `reorderError`. The detail
     * page doesn't need to call this — the action's internal timer
     * handles auto-clear — but the test seam is cleaner with an
     * explicit clearer, and a user navigating away mid-error window
     * benefits from a no-op clear when the page unmounts.
     */
    clearReorderError(): void;
  };
};

/**
 * How long the inline reorder-failure message lingers before
 * auto-clearing. Short enough to feel transient; long enough to
 * read. Co-located with the action that consumes it.
 */
const REORDER_ERROR_LINGER_MS = 4_000;

/**
 * Test seam — same shape as library-store. Returns the unsubscribe
 * handle so the store can detach if it ever needs to (it doesn't,
 * but the API is uniform).
 */
const subscribeToChanges = (cb: () => void): (() => void) | null => {
  if (typeof window === 'undefined') return null;
  const bridge = window.musaic;
  if (!bridge) return null;
  return bridge.playlist.onChanged(cb);
};

/**
 * The "playlist id currently in scope" — null on `home`, the id on
 * either `playlist:N` or `add-tracks:N`. The picker view is
 * conceptually still inside the parent playlist; it reads the same
 * `currentPlaylistDetail`. Centralizing the projection here keeps the
 * subscription and the loadDetail view-check in lockstep — if a
 * fourth view variant ever wants to share the detail scope, it gets
 * added here in one place.
 */
const playlistIdInScope = (view: View): number | null => {
  switch (view.kind) {
    case 'home':
      return null;
    case 'playlist':
      return view.id;
    case 'add-tracks':
      return view.playlistId;
  }
};

export const usePlaylistStore = create<PlaylistState>((set, get) => {
  const refreshList = async (): Promise<void> => {
    try {
      const playlists = await listPlaylistsIpc();
      set({ playlists, loading: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      console.error('playlist-store: refreshList failed', err);
      set({ loading: false, error: message });
    }
  };

  const loadDetail = async (id: number): Promise<void> => {
    set({ detailLoading: true });
    try {
      const detail = await getPlaylistIpc(id);
      // Only commit if the view still wants this id — the user may
      // have navigated away during the in-flight fetch. Both
      // `playlist:N` and `add-tracks:N` are valid landing surfaces
      // for detail id N (the picker reads its parent's detail); the
      // `playlistIdInScope` projection handles both.
      const currentScope = playlistIdInScope(
        useUIStore.getState().currentView,
      );
      if (currentScope !== id) {
        set({ detailLoading: false });
        return;
      }
      set({ currentPlaylistDetail: detail, detailLoading: false });
    } catch (err) {
      console.error('playlist-store: loadDetail failed', err);
      set({ detailLoading: false });
    }
  };

  const clearDetail = (): void => {
    set({ currentPlaylistDetail: null });
  };

  /**
   * Inner: project an array of memberships into a new array ordered
   * by the given playlistTrackId list. Tracks not in the order list
   * are dropped (shouldn't happen in practice — the optimistic
   * caller passes a full ordered set — but defensive). Tracks in
   * the order list but not in `tracks` are also dropped (same
   * argument: shouldn't happen, but better to render fewer tiles
   * than to throw mid-render).
   *
   * Position is renumbered 0..N-1 to mirror the dense-int invariant
   * the main process maintains. The broadcast-driven refresh will
   * overwrite this projection with main's authoritative positions
   * shortly after; the optimistic shape is identity-equal to the
   * post-broadcast shape on success.
   */
  const reorderMemberships = (
    tracks: PlaylistDetail['tracks'],
    orderedPlaylistTrackIds: readonly number[],
  ): PlaylistDetail['tracks'] => {
    const byId = new Map(tracks.map((m) => [m.playlistTrackId, m] as const));
    const next: PlaylistDetail['tracks'][number][] = [];
    orderedPlaylistTrackIds.forEach((id, i) => {
      const m = byId.get(id);
      if (m !== undefined) next.push({ ...m, position: i });
    });
    return next;
  };

  // Timer handle for the auto-clear of reorderError. Module-scoped
  // (one per store instance) — a second failing reorder cancels the
  // pending clear before setting its own.
  let reorderErrorTimer: ReturnType<typeof setTimeout> | null = null;
  const setReorderError = (
    playlistId: number,
    message: string,
  ): void => {
    if (reorderErrorTimer !== null) {
      clearTimeout(reorderErrorTimer);
      reorderErrorTimer = null;
    }
    set({ reorderError: { playlistId, message } });
    reorderErrorTimer = setTimeout(() => {
      reorderErrorTimer = null;
      set({ reorderError: null });
    }, REORDER_ERROR_LINGER_MS);
  };
  const clearReorderError = (): void => {
    if (reorderErrorTimer !== null) {
      clearTimeout(reorderErrorTimer);
      reorderErrorTimer = null;
    }
    set({ reorderError: null });
  };

  const reorderTracks = async (
    playlistId: number,
    orderedPlaylistTrackIds: readonly number[],
  ): Promise<void> => {
    // Snapshot rules from the slice prompt §3:
    //   - take rollback snapshot only if the dispatched playlistId
    //     is the one currently in scope AND a detail is loaded for
    //     that id;
    //   - off-scope dispatches skip the optimistic step;
    //   - scope = `playlistIdInScope(currentView)` covers both
    //     `playlist:N` and `add-tracks:N` (see 4b-correction).
    const scope = playlistIdInScope(useUIStore.getState().currentView);
    const snapshot = get().currentPlaylistDetail;
    const optimisticApplies =
      scope === playlistId &&
      snapshot !== null &&
      snapshot.id === playlistId;

    if (optimisticApplies) {
      set({
        currentPlaylistDetail: {
          ...snapshot,
          tracks: reorderMemberships(
            snapshot.tracks,
            orderedPlaylistTrackIds,
          ),
        },
      });
    }

    try {
      await reorderPlaylistIpc({
        id: playlistId,
        orderedPlaylistTrackIds,
      });
      // Success: do nothing. The `playlist:changed` broadcast will
      // trigger `onPlaylistChanged` → `loadDetail` and the store
      // re-fetches; the result should match the optimistic state.
    } catch (err) {
      console.error('playlist-store: reorderTracks failed', err);
      if (optimisticApplies) {
        // Roll back to the exact snapshot we took above.
        set({ currentPlaylistDetail: snapshot });
      }
      const message = err instanceof Error ? err.message : 'reorder failed';
      setReorderError(playlistId, message);
    }
  };

  /**
   * Handler for any `playlist:changed` signal: refresh the list,
   * and if a playlist is currently in scope (either `playlist:N` or
   * `add-tracks:N`), refresh its detail. Errors during the in-flight
   * fetch are caught inside the wrappers above.
   */
  const onPlaylistChanged = (): void => {
    void get().actions.refreshList();
    const scope = playlistIdInScope(useUIStore.getState().currentView);
    if (scope === null) return;
    const detail = get().currentPlaylistDetail;
    if (detail !== null && detail.id === scope) {
      void get().actions.loadDetail(scope);
    } else if (detail === null && !get().detailLoading) {
      // Playlist in scope but no detail loaded yet — the ui-store
      // subscription below normally drives loadDetail on view changes,
      // but a `playlist:changed` arriving mid-load should still
      // trigger a fresh read.
      void get().actions.loadDetail(scope);
    }
  };

  subscribeToChanges(onPlaylistChanged);

  // Drive detail loading off ui-store. The subscription tracks
  // "playlist id currently in scope" rather than "view kind" so that
  // transitions between `playlist:N` and `add-tracks:N` are no-ops
  // (the picker reads the parent's detail; clearing it on transition
  // would empty the picker page). Transitions to `home` or to a
  // different playlist id clear/reload as before. Module-init
  // subscription, no useEffect.
  if (typeof window !== 'undefined') {
    let lastScope: number | null = playlistIdInScope(
      useUIStore.getState().currentView,
    );
    useUIStore.subscribe((state) => {
      const scope = playlistIdInScope(state.currentView);
      if (scope === lastScope) return;
      lastScope = scope;
      if (scope !== null) {
        void get().actions.loadDetail(scope);
      } else {
        get().actions.clearDetail();
      }
    });
  }

  // Kick off the initial list fetch.
  void refreshList();

  return {
    playlists: [],
    loading: true,
    error: null,
    currentPlaylistDetail: null,
    detailLoading: false,
    reorderError: null,
    actions: {
      refreshList,
      loadDetail,
      clearDetail,
      create: (name) => createPlaylistIpc(name),
      rename: (id, name) => renamePlaylistIpc(id, name),
      delete: (id) => deletePlaylistIpc(id),
      addTracks: (id, tracks) =>
        addTracksToPlaylistIpc({ id, tracks }),
      removeTracks: (id, playlistTrackIds) =>
        removeTracksFromPlaylistIpc(id, playlistTrackIds),
      reorderTracks,
      clearReorderError,
    },
  };
});
