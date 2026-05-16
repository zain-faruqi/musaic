/**
 * Tests for the playlist-store.
 *
 * Strategy: install a mock `window.musaic` BEFORE the store module's
 * top-level code runs. Vitest hoists ESM imports above arbitrary
 * statements, so a plain `globalThis.window = …` after the imports
 * would race the store's module-init subscription. Solution:
 * `vi.hoisted` returns a value that's set up BEFORE imports, and
 * the mock bridge installation happens inside the hoisted block.
 *
 * After the bridge is installed and the store has loaded, the
 * tests drive the store directly. `onChangedCb` is captured inside
 * the bridge spy so tests can fire change signals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistDetail, PlaylistSummary } from '@ipc/contracts';

// Mutable state for the mock; tests can swap return values.
type MockState = {
  list: readonly PlaylistSummary[];
  detail: PlaylistDetail | null;
};

// vi.hoisted runs BEFORE imports (Vitest's mock-hoisting mechanism
// applies to anything inside the callback). This is the only way to
// reliably install a global before the store's module-init code
// observes it.
const mocks = vi.hoisted(() => {
  const state: MockState = { list: [], detail: null };

  // Each fn is a vi.fn so beforeEach can mockClear / mockImplementationOnce.
  const create = vi.fn(async (input: { name: string }) => ({
    kind: 'created' as const,
    playlist: {
      id: 1,
      name: input.name,
      createdAt: 1,
      updatedAt: 1,
    },
  }));
  const rename = vi.fn(async (input: { id: number; name: string }) => ({
    kind: 'renamed' as const,
    playlist: { id: input.id, name: input.name, createdAt: 1, updatedAt: 2 },
  }));
  const deleteFn = vi.fn(async () => undefined);
  const list = vi.fn(async () => state.list);
  const get = vi.fn(async () => state.detail);
  const addTracks = vi.fn(async () => ({ added: 0, skipped: 0 }));
  const removeTracks = vi.fn(async () => ({ removed: 0 }));
  const reorder = vi.fn(async () => undefined);

  // Capture the registered change callback so tests can fire it.
  let onChangedCb: (() => void) | null = null;
  const onChanged = vi.fn((cb: () => void) => {
    onChangedCb = cb;
    return () => {
      onChangedCb = null;
    };
  });
  const fireChange = (): void => onChangedCb?.();

  const bridge = {
    create,
    rename,
    delete: deleteFn,
    list,
    get,
    addTracks,
    removeTracks,
    reorder,
    onChanged,
  };

  // Install on globalThis BEFORE store imports load. The
  // `MusaicBridge` shape has more slices, but the store only uses
  // `playlist`, so an as-cast is safe here.
  (globalThis as unknown as { window: { musaic: { playlist: typeof bridge } } }).window = {
    musaic: { playlist: bridge },
  };

  return {
    state,
    create,
    rename,
    deleteFn,
    list,
    get,
    addTracks,
    removeTracks,
    reorder,
    onChanged,
    fireChange,
  };
});

// Imports must follow the hoisted block (it's hoisted above them
// anyway, but writing them after is clearer about intent).
import { usePlaylistStore } from './playlist-store';
import { useUIStore } from './ui-store';

beforeEach(() => {
  mocks.state.list = [];
  mocks.state.detail = null;
  mocks.create.mockClear();
  mocks.rename.mockClear();
  mocks.deleteFn.mockClear();
  mocks.list.mockClear();
  mocks.get.mockClear();
  mocks.addTracks.mockClear();
  mocks.removeTracks.mockClear();
  mocks.reorder.mockClear();
  // NOTE: do NOT mockClear `onChanged` — it was called once at module
  // init, and that's the call we want to keep accessible to the first
  // assertion below. Each test inspects calls via `mock.calls.length`
  // relative to that baseline.
});

afterEach(() => {
  // Reset view to home so the store's ui-store subscription doesn't
  // bleed a "load detail" call into the next test.
  useUIStore.getState().actions.navigate({ kind: 'home' });
});

describe('playlist-store', () => {
  it('subscribed to playlist:changed at module init', () => {
    // The module-init subscription happens at import time. We don't
    // mockClear onChanged in beforeEach, so this call count
    // reflects the once-and-only subscription.
    expect(mocks.onChanged).toHaveBeenCalledTimes(1);
  });

  it('refreshList fetches via the bridge and stores the result', async () => {
    mocks.state.list = [
      { id: 1, name: 'p', createdAt: 1, updatedAt: 1, trackCount: 0 },
    ];
    await usePlaylistStore.getState().actions.refreshList();
    expect(mocks.list).toHaveBeenCalled();
    expect(usePlaylistStore.getState().playlists).toEqual(mocks.state.list);
    expect(usePlaylistStore.getState().loading).toBe(false);
  });

  it('refreshList sets error on bridge failure', async () => {
    mocks.list.mockRejectedValueOnce(new Error('boom'));
    await usePlaylistStore.getState().actions.refreshList();
    expect(usePlaylistStore.getState().error).toBe('boom');
  });

  it('a playlist:changed signal triggers a list refresh', async () => {
    mocks.state.list = [
      { id: 2, name: 'after', createdAt: 1, updatedAt: 1, trackCount: 0 },
    ];

    mocks.fireChange();
    // The refresh is fire-and-forget; flush microtasks so the
    // listLibrary IPC call resolves before assertion.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.list).toHaveBeenCalled();
  });

  it('create() dispatches the IPC wrapper', async () => {
    const result = await usePlaylistStore.getState().actions.create('foo');
    expect(mocks.create).toHaveBeenCalledWith({ name: 'foo' });
    expect(result.kind).toBe('created');
  });

  it('rename() dispatches the IPC wrapper', async () => {
    const result = await usePlaylistStore
      .getState()
      .actions.rename(1, 'bar');
    expect(mocks.rename).toHaveBeenCalledWith({ id: 1, name: 'bar' });
    expect(result.kind).toBe('renamed');
  });

  it('delete() dispatches the IPC wrapper', async () => {
    await usePlaylistStore.getState().actions.delete(1);
    expect(mocks.deleteFn).toHaveBeenCalledWith({ id: 1 });
  });

  it('addTracks() dispatches the IPC wrapper with id + tracks', async () => {
    mocks.addTracks.mockResolvedValueOnce({ added: 2, skipped: 0 });
    const refs = [
      { source: 'local' as const, sourceId: 'a' },
      { source: 'youtube' as const, sourceId: 'b' },
    ];
    const result = await usePlaylistStore
      .getState()
      .actions.addTracks(3, refs);
    expect(mocks.addTracks).toHaveBeenCalledWith({ id: 3, tracks: refs });
    expect(result).toEqual({ added: 2, skipped: 0 });
  });

  it('addTracks() surfaces the skipped count from the IPC', async () => {
    mocks.addTracks.mockResolvedValueOnce({ added: 1, skipped: 1 });
    const result = await usePlaylistStore
      .getState()
      .actions.addTracks(3, [
        { source: 'local', sourceId: 'a' },
        { source: 'local', sourceId: 'missing' },
      ]);
    expect(result).toEqual({ added: 1, skipped: 1 });
  });

  it('removeTracks() dispatches the IPC wrapper with id + ids', async () => {
    mocks.removeTracks.mockResolvedValueOnce({ removed: 2 });
    const result = await usePlaylistStore
      .getState()
      .actions.removeTracks(3, [10, 11]);
    expect(mocks.removeTracks).toHaveBeenCalledWith({
      id: 3,
      playlistTrackIds: [10, 11],
    });
    expect(result).toEqual({ removed: 2 });
  });

  it('loadDetail() fetches a detail and stores it (view-matching id)', async () => {
    mocks.state.detail = {
      id: 5,
      name: 'p',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    // Navigate first — loadDetail's currentView guard expects the
    // view to point at this id.
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await usePlaylistStore.getState().actions.loadDetail(5);
    expect(mocks.get).toHaveBeenCalledWith({ id: 5 });
    expect(usePlaylistStore.getState().currentPlaylistDetail?.id).toBe(5);
  });

  it('loadDetail() discards its result if the view drifted mid-fetch', async () => {
    mocks.state.detail = {
      id: 5,
      name: 'p',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    // Keep view at home throughout. Slow the bridge get() so we
    // can flip mocks.state mid-flight, then resume the await — the
    // post-await check should see `view.kind === 'home' !== 'playlist'`
    // and bail without landing the detail. This is the "request was
    // for a playlist the view never reached / left while loading"
    // case: superseded fetches don't write.
    let resolveGet: ((v: PlaylistDetail | null) => void) | null = null;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise<PlaylistDetail | null>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const inflight = usePlaylistStore.getState().actions.loadDetail(5);
    // View is already home; finishing the fetch should NOT land detail.
    // The non-null assertion is safe: mockImplementationOnce runs
    // synchronously inside loadDetail's await, so resolveGet is
    // populated by the time we get here.
    resolveGet!(mocks.state.detail);
    await inflight;

    expect(usePlaylistStore.getState().currentPlaylistDetail).toBeNull();
  });

  it('clearDetail() clears the detail field', () => {
    usePlaylistStore.setState({
      currentPlaylistDetail: {
        id: 1,
        name: 'x',
        createdAt: 0,
        updatedAt: 0,
        tracks: [],
      },
    });
    usePlaylistStore.getState().actions.clearDetail();
    expect(usePlaylistStore.getState().currentPlaylistDetail).toBeNull();
  });

  // --- regression: picker-detail-clear bug
  //
  // The original 4b shipped a subscription that tracked view *kind*
  // ("am I on a playlist view?") rather than playlist *id in scope*.
  // Transitioning from playlist:N to add-tracks:N cleared
  // currentPlaylistDetail (because add-tracks isn't a `playlist`
  // kind), which made the picker render "playlist not found" on its
  // primary entry path. The fix tracks "playlist id in scope" — null
  // on home, the id on either playlist or add-tracks — so the two
  // variants share scope. Regression tests below pin the fix.

  it('navigating playlist:N → add-tracks:N does NOT clear or refetch detail', async () => {
    mocks.state.detail = {
      id: 5,
      name: 'p',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    // Flush microtasks so the subscription-driven loadDetail commits.
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlaylistStore.getState().currentPlaylistDetail?.id).toBe(5);
    const callsBefore = mocks.get.mock.calls.length;

    // Now the user clicks "+ Add tracks": same playlist in scope.
    useUIStore
      .getState()
      .actions.navigate({ kind: 'add-tracks', playlistId: 5 });
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlaylistStore.getState().currentPlaylistDetail?.id).toBe(5);
    // No additional fetch — same scope.
    expect(mocks.get.mock.calls.length).toBe(callsBefore);
  });

  it('navigating playlist:N → add-tracks:M (different id) reloads detail', async () => {
    mocks.state.detail = {
      id: 5,
      name: 'p5',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    // Swap the mock's detail to id 7 before the next navigate.
    mocks.state.detail = {
      id: 7,
      name: 'p7',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    useUIStore
      .getState()
      .actions.navigate({ kind: 'add-tracks', playlistId: 7 });
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlaylistStore.getState().currentPlaylistDetail?.id).toBe(7);
    expect(mocks.get).toHaveBeenCalledWith({ id: 7 });
  });

  it('navigating add-tracks:N → home clears detail', async () => {
    mocks.state.detail = {
      id: 5,
      name: 'p',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    useUIStore
      .getState()
      .actions.navigate({ kind: 'add-tracks', playlistId: 5 });
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlaylistStore.getState().currentPlaylistDetail?.id).toBe(5);

    useUIStore.getState().actions.navigate({ kind: 'home' });
    // The subscription clears synchronously; no await needed.
    expect(usePlaylistStore.getState().currentPlaylistDetail).toBeNull();
  });

  it('loadDetail() commits when the view is add-tracks:N matching the fetched id', async () => {
    mocks.state.detail = {
      id: 9,
      name: 'p',
      createdAt: 0,
      updatedAt: 0,
      tracks: [],
    };
    // Navigate directly to add-tracks; the picker is a valid landing
    // surface for detail id 9 even though the user reached it via
    // the parent playlist in production.
    useUIStore
      .getState()
      .actions.navigate({ kind: 'add-tracks', playlistId: 9 });
    await usePlaylistStore.getState().actions.loadDetail(9);
    expect(usePlaylistStore.getState().currentPlaylistDetail?.id).toBe(9);
  });

  // --- reorderTracks action ----------------------------------
  //
  // Coverage matrix from the prompt:
  //   1. Optimistic update lands BEFORE the IPC resolves.
  //   2. IPC success leaves the optimistic state in place (the
  //      broadcast handles the eventual self-correction; tests do
  //      not fire `playlist:changed`).
  //   3. IPC failure restores the snapshot.
  //   4. Off-scope dispatch skips the optimistic step, dispatches
  //      IPC, and (on success) leaves state alone.
  //   5. `add-tracks:N` scope still applies the optimistic update
  //      for playlist N (the scope projection covers both variants).
  //   6. Failure populates `reorderError` with the playlistId; the
  //      timer auto-clears after the linger window.
  //   7. `clearReorderError()` is a no-op when no error is set, and
  //      cancels the pending auto-clear when one is.
  //
  // Helper: build a 3-track playlist detail with playlistTrackIds
  // 10, 20, 30 in positions 0, 1, 2.
  const makeDetail = (id: number): PlaylistDetail => ({
    id,
    name: `p${id}`,
    createdAt: 0,
    updatedAt: 0,
    tracks: [
      {
        playlistTrackId: 10,
        position: 0,
        track: {
          id: 'local:a',
          source: 'local',
          sourceId: 'a',
          title: 'A',
          artists: [],
          durationMs: 0,
        },
      },
      {
        playlistTrackId: 20,
        position: 1,
        track: {
          id: 'local:b',
          source: 'local',
          sourceId: 'b',
          title: 'B',
          artists: [],
          durationMs: 0,
        },
      },
      {
        playlistTrackId: 30,
        position: 2,
        track: {
          id: 'local:c',
          source: 'local',
          sourceId: 'c',
          title: 'C',
          artists: [],
          durationMs: 0,
        },
      },
    ],
  });

  it('reorderTracks() applies the optimistic update BEFORE the IPC resolves', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    // Hold the IPC open so we can assert on the optimistic state
    // mid-flight. The non-null assertion on resolveReorder is
    // valid: mockImplementationOnce runs synchronously inside the
    // action's await, so by the time control returns here it has
    // been populated.
    let resolveReorder: (() => void) | null = null;
    mocks.reorder.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveReorder = () => resolve(undefined);
        }),
    );

    const inflight = usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 10, 20]);

    // Optimistic state: tracks are reordered to [30, 10, 20] with
    // dense-int positions 0, 1, 2. Asserted BEFORE awaiting the
    // dispatch, while the IPC mock is still pending.
    const optimistic = usePlaylistStore.getState().currentPlaylistDetail;
    expect(optimistic?.tracks.map((t) => t.playlistTrackId)).toEqual([
      30, 10, 20,
    ]);
    expect(optimistic?.tracks.map((t) => t.position)).toEqual([0, 1, 2]);

    resolveReorder!();
    await inflight;
  });

  it('reorderTracks() leaves the optimistic state in place on IPC success', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    // Flush microtasks so the subscriber-driven loadDetail lands the
    // detail (mirrors the existing "playlist:N → add-tracks:N" test
    // pattern — navigate + flush is how detail gets installed).
    await Promise.resolve();
    await Promise.resolve();

    await usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [20, 30, 10]);

    // No `playlist:changed` fired (the test doesn't call
    // mocks.fireChange) so the detail should still reflect the
    // optimistic reorder. In production the broadcast races in
    // shortly after and refetches; that's tested separately via
    // the existing playlist:changed → refresh path.
    const after = usePlaylistStore.getState().currentPlaylistDetail;
    expect(after?.tracks.map((t) => t.playlistTrackId)).toEqual([
      20, 30, 10,
    ]);
    expect(mocks.reorder).toHaveBeenCalledWith({
      id: 5,
      orderedPlaylistTrackIds: [20, 30, 10],
    });
  });

  it('reorderTracks() restores the snapshot on IPC failure', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    mocks.reorder.mockRejectedValueOnce(new Error('db locked'));

    await usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 20, 10]);

    // Snapshot restored: original order [10, 20, 30] with positions
    // 0, 1, 2.
    const restored = usePlaylistStore.getState().currentPlaylistDetail;
    expect(restored?.tracks.map((t) => t.playlistTrackId)).toEqual([
      10, 20, 30,
    ]);
    expect(restored?.tracks.map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it('reorderTracks() populates reorderError with the playlistId and message on failure', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    mocks.reorder.mockRejectedValueOnce(new Error('db locked'));

    await usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 20, 10]);

    const err = usePlaylistStore.getState().reorderError;
    expect(err).not.toBeNull();
    expect(err?.playlistId).toBe(5);
    expect(err?.message).toBe('db locked');
  });

  it('reorderTracks() falls back to a generic message when the thrown value is not an Error', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    // Throw a non-Error (e.g. a string from a malformed bridge).
    // The action's instanceof check narrows; falls through to the
    // 'reorder failed' fallback.
    mocks.reorder.mockRejectedValueOnce('not-an-error');

    await usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 20, 10]);

    expect(usePlaylistStore.getState().reorderError?.message).toBe(
      'reorder failed',
    );
  });

  it('reorderTracks() off-scope (different id) skips the optimistic step but still dispatches IPC', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    // Dispatch a reorder for a DIFFERENT id (7). The detail in
    // scope is id 5; the action should leave detail untouched.
    await usePlaylistStore
      .getState()
      .actions.reorderTracks(7, [99, 98, 97]);

    // Detail unchanged.
    const after = usePlaylistStore.getState().currentPlaylistDetail;
    expect(after?.id).toBe(5);
    expect(after?.tracks.map((t) => t.playlistTrackId)).toEqual([
      10, 20, 30,
    ]);
    // IPC still fired.
    expect(mocks.reorder).toHaveBeenCalledWith({
      id: 7,
      orderedPlaylistTrackIds: [99, 98, 97],
    });
  });

  it('reorderTracks() off-scope (view is home) skips the optimistic step', async () => {
    // No navigation: view is home, detail is null. The optimistic
    // branch's `scope === playlistId` check should bail.
    useUIStore.getState().actions.navigate({ kind: 'home' });
    usePlaylistStore.setState({ currentPlaylistDetail: null });

    await usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 20, 10]);

    expect(usePlaylistStore.getState().currentPlaylistDetail).toBeNull();
    expect(mocks.reorder).toHaveBeenCalled();
  });

  it('reorderTracks() applies the optimistic update when scope is add-tracks:N for the same id', async () => {
    // The add-tracks picker shares the parent playlist's detail in
    // scope (per the 4b-correction `playlistIdInScope` projection).
    // A reorder dispatched while the user is on the picker view
    // for playlist 5 should still apply optimistically against the
    // shared detail — even though the picker itself doesn't render
    // the reordered tile row, the parent playlist view will reflect
    // it when the user navigates back.
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore
      .getState()
      .actions.navigate({ kind: 'add-tracks', playlistId: 5 });
    await Promise.resolve();
    await Promise.resolve();

    // Hold the IPC open so we can observe the optimistic state.
    let resolveReorder: (() => void) | null = null;
    mocks.reorder.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveReorder = () => resolve(undefined);
        }),
    );

    const inflight = usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 10, 20]);

    const optimistic = usePlaylistStore.getState().currentPlaylistDetail;
    expect(optimistic?.tracks.map((t) => t.playlistTrackId)).toEqual([
      30, 10, 20,
    ]);

    resolveReorder!();
    await inflight;
  });

  it('reorderTracks() with no detail loaded still dispatches IPC without crashing', async () => {
    // The action's snapshot check requires both `scope ===
    // playlistId` AND `snapshot !== null`. If the user dispatches
    // a reorder for an id that's in scope but whose detail hasn't
    // loaded yet (a possible-but-unlikely race), the optimistic
    // branch is skipped without throwing on `snapshot.tracks`.
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    usePlaylistStore.setState({ currentPlaylistDetail: null });

    await expect(
      usePlaylistStore.getState().actions.reorderTracks(5, [10, 20]),
    ).resolves.toBeUndefined();
    expect(mocks.reorder).toHaveBeenCalled();
  });

  it('clearReorderError() clears a set error', async () => {
    const detail = makeDetail(5);
    mocks.state.detail = detail;
    useUIStore.getState().actions.navigate({ kind: 'playlist', id: 5 });
    await Promise.resolve();
    await Promise.resolve();

    mocks.reorder.mockRejectedValueOnce(new Error('boom'));
    await usePlaylistStore
      .getState()
      .actions.reorderTracks(5, [30, 20, 10]);
    expect(usePlaylistStore.getState().reorderError).not.toBeNull();

    usePlaylistStore.getState().actions.clearReorderError();
    expect(usePlaylistStore.getState().reorderError).toBeNull();
  });

  it('clearReorderError() is a no-op when no error is set', () => {
    usePlaylistStore.setState({ reorderError: null });
    usePlaylistStore.getState().actions.clearReorderError();
    expect(usePlaylistStore.getState().reorderError).toBeNull();
  });
});
