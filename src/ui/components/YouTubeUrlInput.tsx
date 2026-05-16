import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { TrackRef } from '@ipc/contracts';
import { parseYouTubeVideoId } from '@renderer/adapters/youtube/parse-video-id';
import { saveYouTube } from '@renderer/state/library';
import styles from './YouTubeUrlInput.module.css';

/**
 * Paste-and-save affordance for YouTube URLs.
 *
 * Single `add` button → `youtube:save` IPC → renders one of four
 * inline states based on the outcome:
 *
 *   - idle           — input is editable; no message.
 *   - in-flight      — button disabled while save is running.
 *   - saved          — brief success message ("added"), input cleared,
 *                      fades after STATE_DECAY_MS.
 *   - embed-restricted — saved but the video can't be embedded.
 *                      Warning message stays for STATE_DECAY_MS, input
 *                      cleared. The row was saved so the user can
 *                      still click the tile; click-time-unplayability
 *                      handling in NowPlayingBar takes over from there.
 *   - not-found      — error message stays for STATE_DECAY_MS. No row
 *                      saved. Input is preserved so the user can fix
 *                      a typo without retyping.
 *   - parse-error    — local validation rejected the URL before any
 *                      IPC. Same UX as 'not-found' but no network hit.
 *   - save-failed    — generic catch for unexpected errors from main
 *                      (network failure, oEmbed JSON shape change,
 *                      etc.). Distinct from 'not-found' which is the
 *                      documented "video doesn't exist" outcome.
 *
 * The transient states (everything except idle / in-flight) fade
 * after STATE_DECAY_MS via setTimeout. Cleanup on unmount and on
 * state-change cancels the pending timer — no stale fade-outs.
 *
 * The earlier `play` and `queue` buttons are gone. Click-to-play comes
 * from the tile in HomePage; the `add` flow is save-only, matching
 * the iTunes-import vs Apple-Music-streaming distinction the rest of
 * the library follows.
 *
 * Optional `onSaveSuccess(refs)` callback. Fires only on
 * the `'saved'` branch (NOT `'embed-restricted'` — the picker's
 * auto-select should not silently land an unplayable track into a
 * playlist). HomePage's mount sites pass nothing; the picker passes
 * a handler that reconciles refs against `availableTracks`. Pill's
 * internal state machine and rendering are unchanged — the callback
 * is purely additive.
 */

const STATE_DECAY_MS = 2_000;

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'embed-restricted' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'parse-error' }
  | { readonly kind: 'save-failed'; readonly message: string };

const decayingState = (kind: Outcome['kind']): boolean =>
  kind === 'saved' ||
  kind === 'embed-restricted' ||
  kind === 'not-found' ||
  kind === 'parse-error' ||
  kind === 'save-failed';

/**
 * Props. The optional `onSaveSuccess` callback fires after
 * a fully-successful save with the refs of the persisted track. The
 * picker reads it to drive paste-to-add auto-selection; HomePage
 * mounts pass nothing.
 */
type YouTubeUrlInputProps = {
  readonly onSaveSuccess?: (refs: ReadonlyArray<TrackRef>) => void;
};

export const YouTubeUrlInput = ({
  onSaveSuccess,
}: YouTubeUrlInputProps = {}): ReactElement => {
  const [value, setValue] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  // Pending fade-out timer. Stored in a ref so each state transition
  // can cancel the previous decay before scheduling a new one — and
  // so unmount can cancel any in-flight decay without re-rendering.
  const decayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending decay on unmount. Each setOutcome path that
  // triggers a decay below also clears the previous timer before
  // scheduling — this is the safety net for the unmount case.
  useEffect(() => {
    return () => {
      if (decayTimer.current !== null) {
        clearTimeout(decayTimer.current);
        decayTimer.current = null;
      }
    };
  }, []);

  // Schedule the decay-to-idle for any transient state. Centralized
  // so every transient-setting path does the same cancel-and-schedule
  // dance.
  const scheduleDecay = (): void => {
    if (decayTimer.current !== null) clearTimeout(decayTimer.current);
    decayTimer.current = setTimeout(() => {
      decayTimer.current = null;
      setOutcome({ kind: 'idle' });
    }, STATE_DECAY_MS);
  };

  const onAdd = (): void => {
    // Local validation before IPC. Saves a round-trip on obvious
    // failures and surfaces the same UX as the brief's "not-found"
    // for the not-a-URL case (the brief lumps them together as
    // "video not found or private," and from the user's point of
    // view "this isn't a YouTube URL" is the same failure shape).
    const videoId = parseYouTubeVideoId(value);
    if (videoId === null) {
      setOutcome({ kind: 'parse-error' });
      scheduleDecay();
      return;
    }

    setOutcome({ kind: 'in-flight' });
    saveYouTube(value)
      .then((result) => {
        switch (result.kind) {
          case 'saved':
            setOutcome({ kind: 'saved' });
            setValue('');
            scheduleDecay();
            // Tell the parent which refs landed. Invoked
            // AFTER local state settles so a parent re-render driven
            // by the callback doesn't race the pill's own success
            // feedback. Embed-restricted intentionally skips this
            // branch — see component docstring.
            onSaveSuccess?.(result.refs);
            return;
          case 'embed-restricted':
            setOutcome({ kind: 'embed-restricted' });
            setValue('');
            scheduleDecay();
            return;
          case 'not-found':
            // Preserve the input so the user can fix a typo without
            // retyping the whole URL.
            setOutcome({ kind: 'not-found' });
            scheduleDecay();
            return;
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'save failed';
        console.error('YouTubeUrlInput: save failed', err);
        setOutcome({ kind: 'save-failed', message });
        scheduleDecay();
      });
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (value.length > 0 && outcome.kind !== 'in-flight') {
        onAdd();
      }
    }
  };

  // Editing the input clears any decaying state immediately — feels
  // wrong to keep a stale error showing while the user is mid-fix.
  const onChange = (ev: ChangeEvent<HTMLInputElement>): void => {
    setValue(ev.currentTarget.value);
    if (decayingState(outcome.kind)) {
      if (decayTimer.current !== null) {
        clearTimeout(decayTimer.current);
        decayTimer.current = null;
      }
      setOutcome({ kind: 'idle' });
    }
  };

  const isError =
    outcome.kind === 'parse-error' ||
    outcome.kind === 'not-found' ||
    outcome.kind === 'save-failed';

  const message = ((): string | null => {
    switch (outcome.kind) {
      case 'idle':
      case 'in-flight':
        return null;
      case 'saved':
        return 'added';
      case 'embed-restricted':
        return 'saved, but may not play in-app';
      case 'not-found':
        return 'video not found or private';
      case 'parse-error':
        return 'not a YouTube URL';
      case 'save-failed':
        return `save failed: ${outcome.message}`;
    }
  })();

  return (
    <div className={styles.row}>
      <input
        type="text"
        className={`${styles.input} ${isError ? styles.inputError : ''}`}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="paste a YouTube URL"
        aria-label="YouTube URL"
        aria-invalid={isError}
      />
      <button
        type="button"
        className={styles.actionButton}
        onClick={onAdd}
        disabled={value.length === 0 || outcome.kind === 'in-flight'}
        title="save to library"
      >
        {outcome.kind === 'in-flight' ? 'saving…' : 'add'}
      </button>
      {message !== null ? (
        <span
          className={styles.message}
          role={isError ? 'alert' : 'status'}
        >
          {message}
        </span>
      ) : null}
    </div>
  );
};
