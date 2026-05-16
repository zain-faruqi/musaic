import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PlaylistMembership } from '@ipc/contracts';
import { DragHandleIcon } from '../components/Icon';
import { Tile } from '../components/Tile';
import styles from './PlaylistDetailPage.module.css';

const TILE_SIZE = 160;
const REMOVE_CONFIRM_WINDOW_MS = 3_000;

type SortablePlaylistTileProps = {
  readonly membership: PlaylistMembership;
  readonly onPlay: () => void;
  readonly onRemove: () => void;
};

/**
 * One tile per playlist member.
 *
 * Three independent interactions live on this tile:
 *
 *   - **Play** (tile body onClick): plays the playlist from this
 *     index. Inert while in confirm-remove state.
 *   - **Remove** (× button, top-right, hover-visible): two-step
 *     inline confirm with a 3s revert. Existing 4b behavior.
 *   - **Reorder** (drag handle, top-left, hover-visible): drag-only
 *     reorder via dnd-kit. The handle gets `attributes` +
 *     `listeners` from `useSortable`; the tile body does NOT.
 *
 * Boundary discipline:
 *
 *   - The drag handle's pointer events do not propagate to the tile
 *     body's onClick. The DndContext's PointerSensor has a 5px
 *     activation distance so a click on the handle that doesn't move
 *     5px is NOT a drag — without explicit stopPropagation the
 *     handle's onPointerDown would also fire the tile body's onClick
 *     (the body sits behind the handle in the click target stack).
 *     Belt-and-suspenders fix: stopPropagation on the handle's
 *     onPointerDown. Comment naming the boundary it protects.
 *   - The × button keeps its existing stopPropagation (4b).
 *   - The "confirm remove" state does NOT lock the rest of the tile:
 *     the drag handle's listeners are unaffected by `confirming`,
 *     so a user can still drag-reorder a tile that's in confirm-
 *     remove state. The remove state auto-reverts on its 3s timer.
 *
 * The wrapping `.trackCard` div is the sortable node — its `transform`
 * style is what dnd-kit animates during drag. The handle, body, and
 * × button are children whose pointer events are routed independently.
 */
export const SortablePlaylistTile = ({
  membership,
  onPlay,
  onRemove,
}: SortablePlaylistTileProps): ReactElement => {
  const { track, playlistTrackId } = membership;
  const subtitle = track.artists.length > 0 ? track.artists.join(', ') : '';

  // useSortable wires this tile into the enclosing SortableContext.
  // The `id` MUST match what `SortableContext`'s `items` array
  // contains for the same tile — we use `playlistTrackId` end to end
  // (also the IPC contract's key on `playlist:reorder`). `transform`
  // is null at rest and gets a value during drag; `CSS.Transform.
  // toString` is dnd-kit's helper for serializing it into a CSS
  // transform string.
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: playlistTrackId });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // While dragging, lift the tile above its siblings so the dnd-
    // kit overlay isn't visually covered by the next tile in the
    // horizontal row. opacity dimming is a visual cue that the tile
    // is "in transit"; dnd-kit doesn't apply it by default.
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel any pending revert on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const onRemoveClick = (ev: MouseEvent<HTMLButtonElement>): void => {
    // The × sits inside the tile card; without stopPropagation the
    // click would also fire the card's onPlay and we'd start playback
    // at the same time as flipping to confirm-or-commit.
    // (Existing 4b stopPropagation — preserved.)
    ev.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => {
        setConfirming(false);
        timerRef.current = null;
      }, REMOVE_CONFIRM_WINDOW_MS);
      return;
    }
    // Second click within the window — commit.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setConfirming(false);
    onRemove();
  };

  // Card click: only play if we're NOT in confirm state. In confirm
  // state, the only carve-out from "click plays" is the × button
  // itself — clicking elsewhere on the tile is inert.
  const onCardClick = (): void => {
    if (confirming) return;
    onPlay();
  };

  // The drag handle's pointer events are owned by dnd-kit's
  // listeners (spread below). The activation-distance constraint on
  // the DndContext's PointerSensor (5px in PlaylistDetailPage)
  // prevents zero-distance clicks from registering as drags — but
  // the pointerdown event would still bubble to the tile body and
  // fire its onClick on release. stopPropagation on the handle's
  // onPointerDown breaks that chain. Boundary: drag handle →
  // tile-body play onClick.
  const onHandlePointerDown = (ev: MouseEvent<HTMLButtonElement>): void => {
    ev.stopPropagation();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.trackCard} ${confirming ? styles.trackCardConfirming : ''} ${isDragging ? styles.trackCardDragging : ''}`}
      role="listitem"
    >
      <button
        type="button"
        className={`${styles.dragHandle} ${isDragging ? styles.dragHandleActive : ''}`}
        // Spread dnd-kit's attributes (role, aria, tabIndex) and
        // listeners (onPointerDown, onKeyDown for KeyboardSensor) so
        // the handle becomes the actual drag target. Do NOT add an
        // onClick — clicking the handle without dragging is inert by
        // contract.
        {...attributes}
        {...listeners}
        onPointerDown={(ev) => {
          // Run our boundary stopPropagation first…
          onHandlePointerDown(ev);
          // …then delegate to dnd-kit's handler so the drag flow
          // still starts. Spread above wires listeners; this
          // override calls them explicitly because we need our
          // stopPropagation to run before dnd-kit's bubbling.
          listeners?.onPointerDown?.(ev);
        }}
        aria-label="Drag to reorder"
        title="drag to reorder"
      >
        <DragHandleIcon />
      </button>
      <button
        type="button"
        className={styles.trackBody}
        onClick={onCardClick}
        aria-label={`Play ${track.title}${subtitle ? ` by ${subtitle}` : ''}`}
      >
        <div className={styles.tileArt}>
          <Tile
            size={TILE_SIZE}
            ariaLabel={`Artwork for ${track.title}`}
            {...(track.artwork !== undefined && { artworkUrl: track.artwork })}
          />
        </div>
        <div className={styles.trackMeta}>
          <div className={styles.trackTitle}>{track.title}</div>
          <div className={styles.trackSubtitle}>{subtitle}</div>
        </div>
      </button>
      <button
        type="button"
        className={`${styles.removeButton} ${
          confirming ? styles.removeButtonConfirming : ''
        }`}
        onClick={onRemoveClick}
        aria-label={
          confirming
            ? `Confirm remove ${track.title} from playlist`
            : `Remove ${track.title} from playlist`
        }
        title={confirming ? 'click again to remove' : 'remove from playlist'}
      >
        {confirming ? 'remove?' : '×'}
      </button>
    </div>
  );
};
