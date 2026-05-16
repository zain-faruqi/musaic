import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { TrackRef } from '@ipc/contracts';
import type { UnifiedTrack } from '@renderer/core/types';
import { SpotifyUrlInput } from '../components/SpotifyUrlInput';
import { Tile } from '../components/Tile';
import { YouTubeUrlInput } from '../components/YouTubeUrlInput';
import { useLibraryStore } from '@renderer/state/library-store';
import { usePlaylistStore } from '@renderer/state/playlist-store';
import { useUIStore } from '@renderer/state/ui-store';
import {
  composeInlineMessage,
  computeAvailableTracks,
} from '@renderer/state/playlists';
import styles from './AddTracksToPlaylistPage.module.css';

const TILE_SIZE = 160;

/**
 * How long the paste outcome message lingers before auto-clearing.
 * Mirrors `REORDER_ERROR_LINGER_MS` in playlist-store (4_000ms) — same
 * magnitude, different surface; both are inline transient messages
 * the user reads once. Co-located with the consumer.
 */
const PASTE_MESSAGE_LINGER_MS = 4_000;

/**
 * How long a pending ref waits to be reconciled against
 * `availableTracks` before being dropped. Five seconds is wider than
 * any plausible library:changed → listLibrary round-trip; refs that
 * still haven't appeared in availableTracks by then are almost
 * certainly stuck for a reason (the user navigated away from the
 * playlist, the watcher unlinked the row, etc.) and silently
 * forgetting them beats leaking a growing bucket.
 */
const PENDING_REF_DEADLINE_MS = 5_000;

const refKey = (ref: Pick<TrackRef, 'source' | 'sourceId'>): string =>
  `${ref.source}:${ref.sourceId}`;

type AddTracksToPlaylistPageProps = {
  readonly playlistId: number;
};

/**
 * Picker view: pick library tracks to add to the parent playlist.
 *
 * Page-scoped, transient. Selection state is component-local
 * (`useState<Set<string>>` keyed `${source}:${sourceId}`); confirmed
 * adds dispatch via `playlistStore.actions.addTracks` and navigate
 * back to the detail view. Cancel-or-navigate-away discards selection.
 *
 * The list is `useLibraryStore.tracks` filtered against
 * `currentPlaylistDetail.tracks` — already-in-playlist tracks are
 * dropped entirely from the picker. The filter is a pure helper in
 * `state/playlists.ts` so it can be unit-tested in isolation.
 *
 * `playlist:changed` arriving while the picker is open will refresh
 * `currentPlaylistDetail` via the store's existing subscription; the
 * `availableTracks` memo recomputes on the next render. Selection
 * state survives because it's keyed on `${source}:${sourceId}` —
 * never on the detail's surrogate `playlistTrackId`.
 *
 * Paste-to-add. `<YouTubeUrlInput />` and `<SpotifyUrlInput />`
 * mount above the grid; each surfaces `onSaveSuccess(refs)` after a
 * successful paste. The picker holds a `pendingRefs` bucket and runs
 * a reconciliation effect against `availableTracks` /
 * `currentPlaylistDetail.tracks`:
 *
 *   - ref in availableSet AND not already selected →
 *     add to selection, `addedToSelection++`, drop from bucket
 *   - ref in availableSet AND already selected →
 *     no-op (don't double-count), drop from bucket
 *   - ref in `detail.tracks` (already-in-playlist) →
 *     `alreadyInPlaylist++`, drop from bucket
 *   - otherwise → keep in bucket; retry on next availableTracks change
 *
 * The reconciliation handles the library-refresh race: paste IPC
 * resolves → onSaveSuccess fires → ref is added to the bucket → BUT
 * `library:changed`'s `listLibrary()` re-fetch may not have landed
 * yet. The effect re-runs when it does, and the ref matches against
 * a fresh `availableTracks` on the next render. Refs older than
 * `PENDING_REF_DEADLINE_MS` get silently dropped.
 *
 * The `useEffect` is justified here: it's NOT for derived state.
 * `availableTracks` IS derived state (computed via `useMemo` during
 * render). The effect is for the imperative reconciliation that
 * fires in response to an async signal (the paste resolution) — the
 * legitimate `useEffect` case (async signal → imperative
 * reconciliation).
 */
export const AddTracksToPlaylistPage = ({
  playlistId,
}: AddTracksToPlaylistPageProps): ReactElement => {
  const libraryTracks = useLibraryStore((s) => s.tracks);
  const detail = usePlaylistStore((s) => s.currentPlaylistDetail);
  const detailLoading = usePlaylistStore((s) => s.detailLoading);
  const addTracks = usePlaylistStore((s) => s.actions.addTracks);
  const navigate = useUIStore((s) => s.actions.navigate);

  // Component-local — picker selection is page-scoped (CODE_PRACTICES:
  // "anything not shared" stays in component state). Keyed on
  // `${source}:${sourceId}` so picks survive `currentPlaylistDetail`
  // refreshes that change the wrapping `playlistTrackId`s.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // After a confirm with `skipped > 0`, we hold on this page so the
  // user can see the partial-success count. A "Done" button navigates
  // back. When `skipped === 0`, the page just navigates immediately
  // and this state never gets set.
  type Outcome =
    | { readonly kind: 'idle' }
    | { readonly kind: 'in-flight' }
    | {
        readonly kind: 'partial';
        readonly added: number;
        readonly skipped: number;
      }
    | { readonly kind: 'error'; readonly message: string };
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  // --- paste-to-add state --------------------------------------------
  //
  // `pendingRefs`: Map<refKey, enqueuedAt>. The Map (not Set) lets the
  // reconciliation effect age out refs that never match against
  // `availableTracks`. Component-state — survives renders, lives only
  // as long as the page mount.
  //
  // `inlineMessage`: discriminated state for the line under the URL
  // pills. Accumulator counters; auto-dismisses after
  // `PASTE_MESSAGE_LINGER_MS`. Resetting on new paste would lose
  // progress for a rapid-fire double-paste, so we accumulate across
  // pastes until the timer fires.
  const [pendingRefs, setPendingRefs] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  type InlineMessage =
    | { readonly kind: 'none' }
    | {
        readonly kind: 'show';
        readonly addedToSelection: number;
        readonly alreadyInPlaylist: number;
      };
  const [inlineMessage, setInlineMessage] = useState<InlineMessage>({
    kind: 'none',
  });
  // The auto-dismiss timer. Module-scoped via ref so each new message
  // cancels the previous decay before scheduling its own. Cleaned up
  // on unmount.
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // useMemo must run unconditionally per rules-of-hooks, so this
  // sits ABOVE the loading-state early return. The callback handles
  // the null/mismatched-id case inline by returning `[]`. Recomputes
  // only when the library or the parent's detail changes — exactly
  // the two times the available set can shift.
  const availableTracks = useMemo(() => {
    if (detail === null || detail.id !== playlistId) return [];
    return computeAvailableTracks(libraryTracks, detail.tracks);
  }, [libraryTracks, detail, playlistId]);

  // --- Reconciliation effect (paste-to-add) -------------------------
  //
  // The legitimate `useEffect` case: an imperative reconciliation in
  // response to an async signal (paste resolution + subsequent
  // library:changed-driven `availableTracks` update). Not "derived
  // state" — both `addedToSelection` and `alreadyInPlaylist` ARE
  // state we own, computed by walking the bucket once per relevant
  // re-render. The effect itself drops matched refs and aggregates
  // counters; it cannot be expressed as a render-time computation
  // because the side effects (mutating `selected`, scheduling a
  // timer) need to happen exactly once per match cycle.
  //
  // Re-runs when:
  //   - availableTracks changes (library:changed refresh landed)
  //   - detail changes (already-in-playlist set changed)
  //   - pendingRefs changes (a new paste added refs)
  //   - selected changes (so we can re-evaluate "newly-added" vs
  //     "already-selected" against the freshest set without side-
  //     effects inside the setSelected updater — StrictMode runs
  //     updaters twice and would double-count any in-updater
  //     mutation of an outer counter)
  //
  // The early `pendingRefs.size === 0` return keeps the common case
  // (no pending paste) cheap on the toggle-clicks that drive
  // `selected` updates.
  useEffect(() => {
    if (pendingRefs.size === 0) return;
    if (detail === null || detail.id !== playlistId) return;

    // Build O(1) lookup sets for this reconciliation pass.
    const availableSet = new Set<string>();
    for (const t of availableTracks) availableSet.add(refKey(t));
    const playlistSet = new Set<string>();
    for (const m of detail.tracks) playlistSet.add(refKey(m.track));

    const now = Date.now();
    const stillPending = new Map<string, number>();
    let alreadyInPlaylist = 0;
    let addedToSelection = 0;
    // Snapshot the current `selected` set; mutate a local copy and
    // commit once at the end. Reading directly (rather than via the
    // `setSelected` functional updater) avoids the StrictMode
    // double-invocation pitfall: counters incremented inside an
    // updater would double under React's dev-mode rerun.
    const nextSelected = new Set(selected);

    for (const [key, enqueuedAt] of pendingRefs) {
      if (now - enqueuedAt > PENDING_REF_DEADLINE_MS) {
        // Aged out — silently drop. The user won't notice; the bucket
        // doesn't leak.
        continue;
      }
      if (availableSet.has(key)) {
        // Library-resident AND not already in this playlist.
        if (!nextSelected.has(key)) {
          nextSelected.add(key);
          addedToSelection += 1;
        }
        // Else: ref already in selection prior to this paste — a
        // no-op. Spec says don't surface no-ops to the user.
        continue;
      }
      if (playlistSet.has(key)) {
        // Already a member — counts toward the message but never
        // toggles selection (the picker filters these out of the
        // grid anyway per 4b).
        alreadyInPlaylist += 1;
        continue;
      }
      // Not yet in availableTracks AND not yet a member — library
      // refresh probably hasn't landed. Keep for the next cycle.
      stillPending.set(key, enqueuedAt);
    }

    // Commit selection once.
    if (addedToSelection > 0) {
      setSelected(nextSelected);
    }

    // Only commit a new bucket if something changed. Avoids a render
    // loop when the effect runs after the bucket was already empty.
    if (stillPending.size !== pendingRefs.size) {
      setPendingRefs(stillPending);
    }

    // Surface the cumulative inline message. Each effect tick that
    // matches anything resets the linger timer — rapid-fire pastes
    // see their outcomes accumulate. composeInlineMessage returns
    // null on (0, 0), so the render below suppresses the line
    // entirely on no-op ticks (e.g., when only aged-out refs got
    // dropped).
    if (addedToSelection > 0 || alreadyInPlaylist > 0) {
      setInlineMessage((prev) => ({
        kind: 'show',
        addedToSelection:
          (prev.kind === 'show' ? prev.addedToSelection : 0) + addedToSelection,
        alreadyInPlaylist:
          (prev.kind === 'show' ? prev.alreadyInPlaylist : 0) +
          alreadyInPlaylist,
      }));
      if (messageTimer.current !== null) {
        clearTimeout(messageTimer.current);
      }
      messageTimer.current = setTimeout(() => {
        messageTimer.current = null;
        setInlineMessage({ kind: 'none' });
      }, PASTE_MESSAGE_LINGER_MS);
    }
  }, [availableTracks, detail, pendingRefs, playlistId, selected]);

  // Clean up the linger timer on unmount.
  useEffect(() => {
    return () => {
      if (messageTimer.current !== null) {
        clearTimeout(messageTimer.current);
        messageTimer.current = null;
      }
    };
  }, []);

  // Callback the URL pills invoke when a save succeeds. Stable
  // identity via `useCallback` so the pills don't see a new function
  // every render. Merges incoming refs into the pending bucket; the
  // reconciliation effect picks them up on the next render.
  const onPasteSuccess = useCallback(
    (refs: ReadonlyArray<TrackRef>): void => {
      if (refs.length === 0) return;
      const now = Date.now();
      setPendingRefs((prev) => {
        const next = new Map(prev);
        for (const ref of refs) {
          const key = refKey(ref);
          // If a ref was already pending, refresh its timestamp —
          // user just re-asked for the same ref. (Rare; harmless.)
          next.set(key, now);
        }
        return next;
      });
    },
    [],
  );

  // The picker can render before the parent playlist's detail has
  // landed (deep-link, refresh races). Fall through to a loading
  // placeholder rather than crashing. The store's ui-store
  // subscription doesn't drive loadDetail for `add-tracks` views,
  // so guard either with a parent-set detail or an explicit fetch.
  // If detail is null we drop a soft hint and offer Back; the user's
  // entry path (clicking Add tracks in the detail view) guarantees
  // detail is populated, so this is the rare-path safety net only.
  const navigateBack = (): void => {
    navigate({ kind: 'playlist', id: playlistId });
  };

  if (detail === null || detail.id !== playlistId) {
    return (
      <div className={styles.page}>
        <div className={styles.headerRow}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={navigateBack}
          >
            ← back
          </button>
        </div>
        <p className={styles.helper}>
          {detailLoading ? 'loading playlist' : 'playlist not found'}
        </p>
      </div>
    );
  }

  const toggle = (track: UnifiedTrack): void => {
    const key = `${track.source}:${track.sourceId}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const confirm = (): void => {
    if (outcome.kind === 'in-flight') return;
    if (selected.size === 0) return;

    // Map the selection set (keys) back to ref pairs by walking the
    // available list once. We could keep parallel ref objects in the
    // Set, but storing string keys keeps comparison cheap and survives
    // memo re-runs that produce fresh track objects with the same
    // identity.
    const refs = availableTracks
      .filter((t) => selected.has(`${t.source}:${t.sourceId}`))
      .map((t) => ({ source: t.source, sourceId: t.sourceId }));

    setOutcome({ kind: 'in-flight' });
    addTracks(playlistId, refs)
      .then((result) => {
        if (result.skipped === 0) {
          // Full success: navigate back. The `playlist:changed`
          // signal will refresh `currentPlaylistDetail` so the
          // detail view shows the new tiles on landing.
          navigateBack();
          return;
        }
        // Partial success: hold and surface the count. The user
        // dismisses via the inline "Done" button — explicit beats
        // a setTimeout-driven auto-redirect because the user's
        // attention isn't tied to a wall clock.
        setOutcome({
          kind: 'partial',
          added: result.added,
          skipped: result.skipped,
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'add failed';
        console.error('AddTracksToPlaylistPage: addTracks failed', err);
        setOutcome({ kind: 'error', message });
      });
  };

  const buttonLabel =
    selected.size === 1 ? 'Add 1 track' : `Add ${selected.size} tracks`;

  // Compute the rendered inline-message string via the pure helper —
  // returns null when nothing actionable happened, in which case the
  // line doesn't render. Re-runs every render; cheap.
  const inlineMessageText =
    inlineMessage.kind === 'show'
      ? composeInlineMessage(
          inlineMessage.addedToSelection,
          inlineMessage.alreadyInPlaylist,
        )
      : null;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={navigateBack}
        >
          ← back
        </button>
        <div className={styles.headerText}>
          <div className={styles.title}>{detail.name}</div>
          <div className={styles.subhead}>Add tracks</div>
        </div>
        <button
          type="button"
          className={styles.cancelInline}
          onClick={navigateBack}
        >
          Cancel
        </button>
      </div>

      <hr className={styles.rule} />

      {/*
        Paste-to-add. Order matches HomePage's `/ Recently
        Added`: YouTube first, then Spotify. Both pills are mounted
        unconditionally — the user can paste even when their library
        is empty (the paste populates it). The inline message line
        sits directly under the pills; auto-dismisses after
        PASTE_MESSAGE_LINGER_MS.
      */}
      <div className={styles.pasteRow}>
        <YouTubeUrlInput onSaveSuccess={onPasteSuccess} />
        <SpotifyUrlInput onSaveSuccess={onPasteSuccess} />
        {inlineMessageText !== null ? (
          <div className={styles.pasteMessage} role="status">
            {inlineMessageText}
          </div>
        ) : null}
      </div>

      {outcome.kind === 'partial' ? (
        <div className={styles.banner} role="status">
          Added {outcome.added}{' '}
          {outcome.added === 1 ? 'track' : 'tracks'}. {outcome.skipped}{' '}
          skipped (already present or missing).
          <button
            type="button"
            className={styles.bannerButton}
            onClick={navigateBack}
          >
            Done
          </button>
        </div>
      ) : null}
      {outcome.kind === 'error' ? (
        <div className={styles.banner} role="alert">
          add failed: {outcome.message}
        </div>
      ) : null}

      {availableTracks.length === 0 ? (
        <p className={styles.helper}>
          {libraryTracks.length === 0
            ? 'your library is empty — import some tracks first, or paste a URL above.'
            : 'all your library tracks are already in this playlist.'}
        </p>
      ) : (
        <div className={styles.grid} role="list">
          {availableTracks.map((track) => {
            const key = `${track.source}:${track.sourceId}`;
            const isSelected = selected.has(key);
            return (
              <PickerTile
                key={track.id}
                track={track}
                selected={isSelected}
                onToggle={() => toggle(track)}
              />
            );
          })}
        </div>
      )}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.confirmButton}
          onClick={confirm}
          disabled={selected.size === 0 || outcome.kind === 'in-flight'}
        >
          {outcome.kind === 'in-flight' ? 'adding…' : buttonLabel}
        </button>
      </div>
    </div>
  );
};

// --- subcomponents (file-local) -----------------------------------------

type PickerTileProps = {
  readonly track: UnifiedTrack;
  readonly selected: boolean;
  readonly onToggle: () => void;
};

/**
 * One picker tile. Whole-tile click toggles selection (the prompt
 * locks in "tile click toggles selection; the checkbox is a visual
 * indicator"). The native checkbox is rendered for accessibility —
 * screen readers see the role/state — but it sits on top of the
 * artwork as a corner indicator and shares the same click handler.
 * The click bubbles from the inner checkbox up to the button, so a
 * single `onClick` on the button is enough.
 */
const PickerTile = ({
  track,
  selected,
  onToggle,
}: PickerTileProps): ReactElement => {
  const subtitle = track.artists.length > 0 ? track.artists.join(', ') : '';
  const label = `${selected ? 'Unselect' : 'Select'} ${track.title}${subtitle ? ` by ${subtitle}` : ''}`;
  return (
    <button
      type="button"
      className={`${styles.tileCard} ${selected ? styles.tileCardSelected : ''}`}
      onClick={onToggle}
      role="listitem"
      aria-pressed={selected}
      aria-label={label}
    >
      <div className={styles.tileArt}>
        <Tile
          size={TILE_SIZE}
          ariaLabel={`Artwork for ${track.title}`}
          {...(track.artwork !== undefined && { artworkUrl: track.artwork })}
        />
        <span
          className={`${styles.checkbox} ${selected ? styles.checkboxSelected : ''}`}
          aria-hidden="true"
        >
          {selected ? '✓' : ''}
        </span>
      </div>
      <div className={styles.tileMeta}>
        <div className={styles.tileTitle}>{track.title}</div>
        <div className={styles.tileSubtitle}>{subtitle}</div>
      </div>
    </button>
  );
};
