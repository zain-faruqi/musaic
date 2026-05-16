import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { TrackRef } from '@ipc/contracts';
import { parseSpotifyInput } from '@renderer/core/spotify-uri';
import { saveSpotify } from '@renderer/state/library';
import styles from './SpotifyUrlInput.module.css';

/**
 * Paste-and-save / paste-and-import affordance for Spotify track,
 * playlist, and album URIs and URLs.
 *
 * Accepts track, playlist, and album inputs. For tracks: paste-and-
 * save. For playlists and albums: paste-and-import — main imports
 * all playable tracks (paginated, 10,000 max), broadcasts
 * library:changed per page so the library populates incrementally,
 * and returns `{ kind: 'imported', imported, skipped, truncated }`.
 * Same paste-and-import path for both,
 * 'imported' response variant (the message copy is identical:
 * "imported N tracks", no album-vs-playlist distinction surfaced).
 *
 * Variants:
 *
 *   - idle              — input is editable; no message.
 *   - in-flight         — button disabled while save/import is running.
 *                         Same state covers track-save, playlist-import,
 *                         and album-import; large playlists/albums can
 *                         take a while, but the per-page broadcasts mean
 *                         the library is visibly populating throughout,
 *                         so a single "saving…" label is honest enough.
 *   - saved             — track success; input cleared.
 *   - imported          — playlist or album success; carries totals for
 *                         inline display (e.g. "imported 12 tracks").
 *                         Input cleared.
 *   - auth-required     — Spotify not connected (or refresh failed).
 *                         Points the user at the navbar auth widget.
 *                         No row was saved.
 *   - invalid-input     — input wasn't a parseable track-or-playlist-
 *                         or-album URI/URL.
 *   - not-found         — Web API returned 404. Track was deleted,
 *                         playlist is private/deleted, or album was
 *                         removed from the catalog.
 *   - network-error     — fetch failed, 429 after retry, or schema
 *                         mismatch. Retryable.
 *   - parse-error       — local validation failed before IPC. Same
 *                         feel as 'invalid-input' but no round-trip.
 *   - save-failed       — generic catch for unexpected errors.
 *
 * Spotify's `'auth-required'` does NOT inline a "Connect Spotify"
 * button. Why: connection is a multi-second OAuth dance that opens
 * an external browser; embedding a button next to the save pill
 * would make the failure feel like a one-tap fix when it isn't. The
 * connections row in Settings is the canonical place; the inline
 * message points there.
 *
 * Single-flight: the `in-flight` state disables both the button AND
 * the input so a second paste-and-Enter during a long playlist
 * import can't kick off a parallel one. Spec: "single-flight per
 * paste".
 *
 * Optional `onSaveSuccess(refs)` callback. Fires on both `'saved'`
 * (single track) and `'imported'` (playlist or album) branches with
 * the refs of every track that landed in the library.
 * HomePage's mount sites pass nothing; the picker passes a handler
 * that reconciles refs against `availableTracks`. The pill's
 * internal state machine and rendering are unchanged — additive
 * surface only.
 */

/**
 * Transient states fade back to idle after this long. The imported
 * variant uses a longer dwell — 3s — because the user needs time to
 * read the totals; for everything else 2s is enough.
 */
const STATE_DECAY_MS = 2_000;
const IMPORTED_DECAY_MS = 3_000;

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'saved' }
  | {
      readonly kind: 'imported';
      readonly imported: number;
      readonly skipped: number;
      readonly truncated: boolean;
    }
  | { readonly kind: 'auth-required' }
  | { readonly kind: 'invalid-input' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'network-error' }
  | { readonly kind: 'parse-error' }
  | { readonly kind: 'save-failed'; readonly message: string };

const decayingState = (kind: Outcome['kind']): boolean =>
  kind === 'saved' ||
  kind === 'imported' ||
  kind === 'auth-required' ||
  kind === 'invalid-input' ||
  kind === 'not-found' ||
  kind === 'network-error' ||
  kind === 'parse-error' ||
  kind === 'save-failed';

/**
 * Props. The optional `onSaveSuccess` callback fires after a
 * fully-successful save or import with the refs of every track that
 * landed. The picker reads it to drive paste-to-add auto-selection;
 * HomePage mount sites pass nothing.
 */
type SpotifyUrlInputProps = {
  readonly onSaveSuccess?: (refs: ReadonlyArray<TrackRef>) => void;
};

export const SpotifyUrlInput = ({
  onSaveSuccess,
}: SpotifyUrlInputProps = {}): ReactElement => {
  const [value, setValue] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  // Pending fade-out timer. Same ref-stored pattern as
  // YouTubeUrlInput — see that component's comments for the
  // unmount-cancel rationale.
  const decayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (decayTimer.current !== null) {
        clearTimeout(decayTimer.current);
        decayTimer.current = null;
      }
    };
  }, []);

  const scheduleDecay = (delayMs: number = STATE_DECAY_MS): void => {
    if (decayTimer.current !== null) clearTimeout(decayTimer.current);
    decayTimer.current = setTimeout(() => {
      decayTimer.current = null;
      setOutcome({ kind: 'idle' });
    }, delayMs);
  };

  const onAdd = (): void => {
    // Local validation: `parseSpotifyInput` accepts BOTH tracks and
    // playlists. Returns null for albums, malformed strings, etc. —
    // pre-flight the check so
    // obvious bad input doesn't hit IPC.
    const parsed = parseSpotifyInput(value);
    if (parsed === null) {
      setOutcome({ kind: 'parse-error' });
      scheduleDecay();
      return;
    }

    setOutcome({ kind: 'in-flight' });
    saveSpotify(value)
      .then((result) => {
        switch (result.kind) {
          case 'saved':
            setOutcome({ kind: 'saved' });
            setValue('');
            scheduleDecay();
            // Surface refs to the parent after local state settles,
            // so a parent re-render driven by the callback
            // doesn't race the pill's own success feedback.
            onSaveSuccess?.(result.refs);
            return;
          case 'imported':
            setOutcome({
              kind: 'imported',
              imported: result.imported,
              skipped: result.skipped,
              truncated: result.truncated,
            });
            setValue('');
            // Longer dwell so the user can read the totals before
            // the pill fades.
            scheduleDecay(IMPORTED_DECAY_MS);
            // Surface bulk refs too. The picker's inline
            // message ("Added N to selection. M already in this
            // playlist.") and the pill's own "imported N tracks"
            // copy coexist — different jobs.
            onSaveSuccess?.(result.refs);
            return;
          case 'auth-required':
            setOutcome({ kind: 'auth-required' });
            scheduleDecay();
            return;
          case 'invalid-input':
            // Defensive: the local parser caught the obvious cases
            // above, but main's parser is the source of truth and
            // could in theory reject something this one accepted.
            // Preserve the input so the user can fix it.
            setOutcome({ kind: 'invalid-input' });
            scheduleDecay();
            return;
          case 'not-found':
            setOutcome({ kind: 'not-found' });
            scheduleDecay();
            return;
          case 'network-error':
            setOutcome({ kind: 'network-error' });
            scheduleDecay();
            return;
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'save failed';
        console.error('SpotifyUrlInput: save failed', err);
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

  // `auth-required` and the success variants are informational, not
  // errors. Render them as status messages, not aria-invalid. Other
  // failure variants ARE errors.
  const isError =
    outcome.kind === 'parse-error' ||
    outcome.kind === 'invalid-input' ||
    outcome.kind === 'not-found' ||
    outcome.kind === 'network-error' ||
    outcome.kind === 'save-failed';

  const message = ((): string | null => {
    switch (outcome.kind) {
      case 'idle':
        return null;
      case 'in-flight':
        return null;
      case 'saved':
        return 'added';
      case 'imported': {
        // Compose imported message from totals. Truncated trumps
        // skipped — if the playlist hit the cap, that's the more
        // important caveat. Otherwise show skipped only when non-zero.
        const base = `imported ${outcome.imported} track${outcome.imported === 1 ? '' : 's'}`;
        if (outcome.truncated) {
          return `${base} (truncated at 10000)`;
        }
        if (outcome.skipped > 0) {
          return `${base}, ${outcome.skipped} skipped`;
        }
        return base;
      }
      case 'auth-required':
        return 'connect Spotify in settings to save tracks';
      case 'invalid-input':
      case 'parse-error':
        return 'not a Spotify track, playlist, or album URL';
      case 'not-found':
        return 'not found';
      case 'network-error':
        return 'network error — try again';
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
        placeholder="paste a Spotify URL"
        aria-label="Spotify URL"
        aria-invalid={isError}
        // Disable during in-flight so a second paste-and-Enter can't
        // start a parallel import. Single-flight per paste.
        disabled={outcome.kind === 'in-flight'}
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
