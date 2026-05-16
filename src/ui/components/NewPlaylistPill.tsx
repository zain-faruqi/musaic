import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { usePlaylistStore } from '@renderer/state/playlist-store';
import styles from './NewPlaylistPill.module.css';

/**
 * Inline pill input for creating a new playlist.
 *
 * UX shape: a `+ New playlist` text button by default; clicking
 * swaps to an editable text input. Submit on Enter, cancel on
 * Escape, cancel on outside click. Validation errors surface
 * inline (red-ish text just below the row); the input keeps focus.
 *
 * Implements only the create flow — playlist:add-tracks, rename,
 * and delete are wired in other surfaces (PlaylistDetailPage).
 * This component intentionally has no "save" button; Enter is the
 * commit gesture, matching the YouTubeUrlInput / SpotifyUrlInput
 * conventions where the affordance is a typing one.
 */
type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight' }
  | {
      readonly kind: 'invalid-name';
      readonly reason: 'empty' | 'too-long';
    }
  | { readonly kind: 'create-failed'; readonly message: string };

export const NewPlaylistPill = (): ReactElement => {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const create = usePlaylistStore((s) => s.actions.create);

  // Focus the input when the pill enters active mode. useEffect is
  // the right tool here — it's synchronizing with the DOM (focus is
  // an imperative concern that React doesn't render), not deriving
  // state from props.
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  // Click-outside to cancel. Lives on `document` because the click
  // can land anywhere; we only need to know "was the click NOT
  // inside our container?" Bound conditionally on `active` so we
  // don't carry the listener at rest.
  useEffect(() => {
    if (!active) return;
    const onDocMouseDown = (ev: MouseEvent): void => {
      const node = containerRef.current;
      if (node && !node.contains(ev.target as Node)) {
        setActive(false);
        setValue('');
        setOutcome({ kind: 'idle' });
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [active]);

  const enterActive = (): void => {
    setActive(true);
    setOutcome({ kind: 'idle' });
  };

  const cancel = (): void => {
    setActive(false);
    setValue('');
    setOutcome({ kind: 'idle' });
  };

  const submit = (): void => {
    if (outcome.kind === 'in-flight') return;
    setOutcome({ kind: 'in-flight' });
    create(value)
      .then((result) => {
        if (result.kind === 'created') {
          // Reset to idle. The store's playlist:changed-driven
          // refresh will surface the new tile.
          setValue('');
          setActive(false);
          setOutcome({ kind: 'idle' });
        } else {
          // 'invalid-name'
          setOutcome({ kind: 'invalid-name', reason: result.reason });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'create failed';
        console.error('NewPlaylistPill: create failed', err);
        setOutcome({ kind: 'create-failed', message });
      });
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  };

  const onChange = (ev: ChangeEvent<HTMLInputElement>): void => {
    setValue(ev.currentTarget.value);
    // Clear validation error as user types.
    if (
      outcome.kind === 'invalid-name' ||
      outcome.kind === 'create-failed'
    ) {
      setOutcome({ kind: 'idle' });
    }
  };

  const errorMessage = ((): string | null => {
    switch (outcome.kind) {
      case 'idle':
      case 'in-flight':
        return null;
      case 'invalid-name':
        return outcome.reason === 'empty'
          ? 'name is empty'
          : 'name is too long (max 256 characters)';
      case 'create-failed':
        return `create failed: ${outcome.message}`;
    }
  })();

  const isError =
    outcome.kind === 'invalid-name' || outcome.kind === 'create-failed';

  if (!active) {
    return (
      <button
        type="button"
        className={styles.idlePill}
        onClick={enterActive}
        title="create a new playlist"
      >
        + New playlist
      </button>
    );
  }

  return (
    <div ref={containerRef} className={styles.row}>
      <input
        ref={inputRef}
        type="text"
        className={`${styles.input} ${isError ? styles.inputError : ''}`}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="playlist name"
        aria-label="new playlist name"
        aria-invalid={isError}
        disabled={outcome.kind === 'in-flight'}
      />
      {errorMessage !== null ? (
        <span className={styles.message} role="alert">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
};
