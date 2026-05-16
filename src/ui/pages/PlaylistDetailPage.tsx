import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { toUnifiedTrack } from '@renderer/state/library';
import { usePlayerStore } from '@renderer/state/player-store';
import { usePlaylistStore } from '@renderer/state/playlist-store';
import { useUIStore } from '@renderer/state/ui-store';
import { SortablePlaylistTile } from './SortablePlaylistTile';
import styles from './PlaylistDetailPage.module.css';

const DELETE_CONFIRM_WINDOW_MS = 3_000;
// Activation-distance constraint for the PointerSensor. The tile
// body button's onClick (play) is the conflicting interaction — a
// fast click on the drag handle, or even on the tile body itself,
// could otherwise register as a zero-distance drag and either
// swallow the play action or fire one drag-end with no movement.
// 5px is dnd-kit's documented sane default for this scenario.
const DRAG_ACTIVATION_DISTANCE_PX = 5;

type PlaylistDetailPageProps = {
  readonly id: number;
};

/**
 * Detail view for a single playlist.
 *
 * Header: name (click to rename), "Add tracks" button, "delete
 * playlist" button with inline confirm. Back button on the left.
 *
 * Body: a horizontal row of `<SortablePlaylistTile>`s when the
 * playlist has tracks, or an empty-state with a prominent
 * Add-tracks affordance when it's empty.
 *
 * 4b additions (preserved):
 *   - "Add tracks" navigates to the picker view variant.
 *   - Clicking a track tile dispatches `setQueue(tracks, { cursor:
 *     index, autoplay: true })` against the player store.
 *   - Per-tile hover-× with 3s inline confirm removes a single track.
 *
 * 4c additions:
 *   - The tile row is wrapped in a `DndContext` + `SortableContext`
 *     (horizontalListSortingStrategy because the layout is a
 *     horizontal scroll row).
 *   - Each tile exposes a hover-visible drag handle (top-left).
 *   - Drop dispatches `playlist-store.reorderTracks`, which applies
 *     the optimistic reorder + IPC dispatch + rollback-on-failure.
 *   - On reorder failure, an inline error message renders above the
 *     tile row for `REORDER_ERROR_LINGER_MS` (handled in the store).
 *
 * The view is driven entirely by `usePlaylistStore`. No useEffect
 * for data fetching; the store's ui-store subscription handles
 * loadDetail on view changes.
 */
export const PlaylistDetailPage = ({
  id,
}: PlaylistDetailPageProps): ReactElement => {
  const detail = usePlaylistStore((s) => s.currentPlaylistDetail);
  const detailLoading = usePlaylistStore((s) => s.detailLoading);
  const reorderError = usePlaylistStore((s) => s.reorderError);
  const rename = usePlaylistStore((s) => s.actions.rename);
  const remove = usePlaylistStore((s) => s.actions.delete);
  const removeTracks = usePlaylistStore((s) => s.actions.removeTracks);
  const reorderTracks = usePlaylistStore((s) => s.actions.reorderTracks);
  const setQueue = usePlayerStore((s) => s.actions.setQueue);
  const navigate = useUIStore((s) => s.actions.navigate);

  // Sensors are stable across renders (useSensors memoizes); the
  // PointerSensor's activation-distance prevents zero-distance
  // drags from clicks (see DRAG_ACTIVATION_DISTANCE_PX), the
  // KeyboardSensor wires Space/Arrow keyboard reorder out of the
  // box.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const goHome = (): void => {
    navigate({ kind: 'home' });
  };

  const goAddTracks = (): void => {
    navigate({ kind: 'add-tracks', playlistId: id });
  };

  // Derive the SortableContext items array from detail.tracks. This
  // is exactly the kind of derived value the "no useEffect for
  // derived state" rule applies to — compute it during
  // render, not after. useMemo only because the array identity
  // matters for SortableContext's child reconciliation.
  const itemIds = useMemo(
    () => detail?.tracks.map((t) => t.playlistTrackId) ?? [],
    [detail],
  );

  // Loading state: store hasn't yet populated detail for this id.
  if (detail === null || detail.id !== id) {
    return (
      <div className={styles.page}>
        <div className={styles.headerRow}>
          <button
            type="button"
            className={styles.backButton}
            onClick={goHome}
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

  const onTileClick = (index: number): void => {
    // Project each membership row to its UnifiedTrack. The queue
    // becomes the full playlist in `position` order. (4b behavior.)
    const tracks = detail.tracks.map((m) => toUnifiedTrack(m.track));
    setQueue(tracks, { cursor: index, autoplay: true });
  };

  const onRequestRemove = (playlistTrackId: number): void => {
    removeTracks(id, [playlistTrackId]).catch((err: unknown) => {
      console.error(
        'PlaylistDetailPage: removeTracks failed',
        err,
      );
    });
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    // No drop target, or dropped on self — nothing to do.
    if (over === null || active.id === over.id) return;
    const items = detail.tracks.map((t) => t.playlistTrackId);
    // `active.id` and `over.id` are typed as `UniqueIdentifier`
    // (`string | number`). We registered numeric ids (the membership
    // playlistTrackIds) so the cast is safe — and confirmed by the
    // `indexOf` below not returning -1 in practice.
    const oldIndex = items.indexOf(active.id as number);
    const newIndex = items.indexOf(over.id as number);
    // Defensive: if either id isn't in the current list (mid-flight
    // refresh dropped it, or the user dragged something while the
    // store was concurrently mutating), bail. Better to drop a drop
    // than to ship a malformed reorder.
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(items, oldIndex, newIndex);
    // Fire-and-forget — the action's internal error handling rolls
    // back the optimistic update and populates `reorderError` on
    // failure. void-prefix marks the no-await intentional per
    // no floating promises.
    void reorderTracks(id, reordered);
  };

  // Only show the reorder error message if it's scoped to THIS
  // playlist (the action carries the id; the user could have
  // navigated between dispatch and failure).
  const inlineReorderError =
    reorderError !== null && reorderError.playlistId === id
      ? reorderError.message
      : null;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.backButton}
          onClick={goHome}
        >
          ← back
        </button>
        <RenameableTitle name={detail.name} onRename={(n) => rename(id, n)} />
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.addButton}
            onClick={goAddTracks}
            title="add tracks to this playlist"
          >
            + Add tracks
          </button>
          <DeleteButton
            onDelete={async () => {
              await remove(id);
              navigate({ kind: 'home' });
            }}
          />
        </div>
      </div>

      <hr className={styles.rule} />

      {inlineReorderError !== null ? (
        <p className={styles.reorderError} role="alert">
          couldn’t reorder: {inlineReorderError}
        </p>
      ) : null}

      {detail.tracks.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.helper}>this playlist is empty.</p>
          <button
            type="button"
            className={styles.emptyAddButton}
            onClick={goAddTracks}
          >
            + Add tracks from your library
          </button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={itemIds}
            strategy={horizontalListSortingStrategy}
          >
            <div className={styles.row} role="list">
              {detail.tracks.map((m, i) => (
                <SortablePlaylistTile
                  key={m.playlistTrackId}
                  membership={m}
                  onPlay={() => onTileClick(i)}
                  onRemove={() => onRequestRemove(m.playlistTrackId)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
};

// --- subcomponents (file-local) -----------------------------------------

type RenameableTitleProps = {
  readonly name: string;
  readonly onRename: (
    name: string,
  ) => Promise<{
    readonly kind: 'renamed' | 'invalid-name';
    readonly reason?: 'empty' | 'too-long';
  }>;
};

/**
 * The playlist name + click-to-edit affordance. Mirrors
 * NewPlaylistPill's submit/cancel semantics: Enter commits, Escape
 * cancels, outside click cancels. Validation errors surface inline
 * below the row.
 *
 * Cancellation reverts to the original name from props — the store
 * is the source of truth.
 */
const RenameableTitle = ({
  name,
  onRename,
}: RenameableTitleProps): ReactElement => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  // Keep draft in sync if the props change while not editing (e.g.
  // the store refreshed the row).
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  // Focus on entering edit mode.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Click-outside to cancel — same shape as NewPlaylistPill.
  useEffect(() => {
    if (!editing) return;
    const onDocMouseDown = (ev: globalThis.MouseEvent): void => {
      const node = containerRef.current;
      if (node && !node.contains(ev.target as Node)) {
        setEditing(false);
        setDraft(name);
        setErrorMessage(null);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [editing, name]);

  const submit = (): void => {
    onRename(draft)
      .then((result) => {
        if (result.kind === 'renamed') {
          setEditing(false);
          setErrorMessage(null);
        } else {
          setErrorMessage(
            result.reason === 'empty'
              ? 'name is empty'
              : 'name is too long (max 256 characters)',
          );
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'rename failed';
        console.error('PlaylistDetailPage: rename failed', err);
        setErrorMessage(`rename failed: ${message}`);
      });
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      setEditing(false);
      setDraft(name);
      setErrorMessage(null);
    }
  };

  const onChange = (ev: ChangeEvent<HTMLInputElement>): void => {
    setDraft(ev.currentTarget.value);
    if (errorMessage !== null) setErrorMessage(null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.titleButton}
        onClick={() => setEditing(true)}
        title="click to rename"
      >
        {name}
      </button>
    );
  }

  return (
    <span ref={containerRef} className={styles.titleEditWrap}>
      <input
        ref={inputRef}
        type="text"
        className={`${styles.titleInput} ${
          errorMessage !== null ? styles.titleInputError : ''
        }`}
        value={draft}
        onChange={onChange}
        onKeyDown={onKeyDown}
        aria-label="rename playlist"
        aria-invalid={errorMessage !== null}
      />
      {errorMessage !== null ? (
        <span className={styles.titleError} role="alert">
          {errorMessage}
        </span>
      ) : null}
    </span>
  );
};

type DeleteButtonProps = {
  readonly onDelete: () => Promise<void>;
};

/**
 * Delete-with-inline-confirm. First click flips to a "delete?"
 * label; a second click within ~3s commits. The label auto-reverts
 * after the window expires. No modal — keeps the UI flat.
 */
const DeleteButton = ({ onDelete }: DeleteButtonProps): ReactElement => {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel any pending revert on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const onClick = (): void => {
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => {
        setConfirming(false);
        timerRef.current = null;
      }, DELETE_CONFIRM_WINDOW_MS);
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    onDelete().catch((err: unknown) => {
      console.error('DeleteButton: delete failed', err);
    });
  };

  return (
    <button
      type="button"
      className={`${styles.deleteButton} ${
        confirming ? styles.deleteButtonConfirming : ''
      }`}
      onClick={onClick}
      title="delete this playlist"
    >
      {confirming ? 'delete?' : 'delete playlist'}
    </button>
  );
};
