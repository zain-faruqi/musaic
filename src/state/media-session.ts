import { usePlayerStore } from './player-store';

/**
 * Web MediaSession integration.
 *
 * Setting `navigator.mediaSession` metadata + action handlers tells the
 * renderer's Chromium runtime to publish to macOS's MPNowPlayingInfoCenter
 * and MPRemoteCommandCenter. The result: media keys, AirPods double-tap,
 * Bluetooth remote, the Control Center widget, and lock screen controls
 * all drive the player without a native bridge.
 *
 * For M1 (local files via LocalAdapter using a real <audio> element)
 * this works out of the box. For M2 (Spotify via Web Playback SDK,
 * which doesn't expose a single audio element) the bridge may need to
 * be revisited.
 *
 * Caveat: macOS only routes media keys to apps with an active media
 * session, which Chromium activates once an audio element has played.
 * First-time-after-app-launch presses of the play key won't route here
 * until the user has played at least one track. Same behavior as Spotify.
 */

const setupMediaSession = (): void => {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    console.warn('media-session: navigator.mediaSession not available');
    return;
  }

  const session = navigator.mediaSession;
  const { actions } = usePlayerStore.getState();

  // Action handlers — wired once. References are stable for the
  // lifetime of the renderer.
  session.setActionHandler('play', () => actions.play());
  session.setActionHandler('pause', () => actions.pause());
  session.setActionHandler('previoustrack', () => actions.previous());
  session.setActionHandler('nexttrack', () => actions.next());
  session.setActionHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number') {
      actions.seek(details.seekTime * 1000);
    }
  });
  session.setActionHandler('seekbackward', (details) => {
    const offsetMs = (details.seekOffset ?? 10) * 1000;
    const state = usePlayerStore.getState();
    actions.seek(Math.max(0, state.positionMs - offsetMs));
  });
  session.setActionHandler('seekforward', (details) => {
    const offsetMs = (details.seekOffset ?? 10) * 1000;
    const state = usePlayerStore.getState();
    const max = state.current?.durationMs ?? Number.POSITIVE_INFINITY;
    actions.seek(Math.min(max, state.positionMs + offsetMs));
  });
  session.setActionHandler('stop', () => actions.pause());

  // Track + position updates.
  let lastTrackId: string | null = null;
  // setPositionState can throw in odd configurations (duration < position
  // briefly during track-end edge cases). We log once and stop spamming.
  let positionStateFailedOnce = false;

  usePlayerStore.subscribe((state) => {
    // playbackState — surfaces in the OS widget's play/pause icon.
    session.playbackState =
      state.playbackState === 'playing'
        ? 'playing'
        : state.playbackState === 'paused' || state.playbackState === 'idle'
        ? 'paused'
        : 'none';

    // Metadata — only re-allocate when the track itself changes (otherwise
    // we'd recreate MediaMetadata several times a second on timeupdate).
    if (state.current && state.current.id !== lastTrackId) {
      lastTrackId = state.current.id;
      session.metadata = new MediaMetadata({
        title: state.current.title,
        artist: state.current.artists.join(', '),
        album: state.current.album ?? '',
        artwork: state.current.artwork
          ? [{ src: state.current.artwork, sizes: '512x512' }]
          : [],
      });
    } else if (!state.current && lastTrackId !== null) {
      lastTrackId = null;
      session.metadata = null;
    }

    // Position state — drives the scrubber in the OS widget.
    if (state.current && state.current.durationMs > 0) {
      try {
        session.setPositionState({
          duration: state.current.durationMs / 1000,
          position: Math.min(state.positionMs, state.current.durationMs) / 1000,
          playbackRate: 1,
        });
      } catch (err) {
        if (!positionStateFailedOnce) {
          positionStateFailedOnce = true;
          console.warn(
            'media-session: setPositionState failed (suppressing further warnings)',
            err,
          );
        }
      }
    }
  });
};

setupMediaSession();
