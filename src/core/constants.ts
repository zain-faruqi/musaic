/**
 * How early before track end to begin pre-warming the next adapter.
 * The next adapter's volume is held at 0 until handoff.
 *
 */
export const PRELOAD_LEAD_MS = 5_000;

/**
 * Spotify Web Playback SDK position polling interval.
 */
export const POLL_INTERVAL_SPOTIFY_MS = 250;

/**
 * YouTube IFrame Player API has no native timeupdate event, so the
 * youtube adapter polls getCurrentTime(). 200ms balances accuracy
 * against CPU.
 */
export const POLL_INTERVAL_YOUTUBE_MS = 200;

/**
 * Maximum time to wait for a new adapter to confirm it's playing during
 * a handoff before falling back to the gap path. Bounded by the 1.5s
 * cross-source gap target.
 */
export const HANDOFF_VERIFY_TIMEOUT_MS = 1_500;

/**
 * Tolerance window for the duration component of fuzzy dedup.
 */
export const DEDUP_DURATION_TOLERANCE_MS = 2_000;

/**
 * "Previous track" button behavior threshold. If the current position is
 * <= this many ms into the track, "previous" goes to the actual previous
 * track. Beyond it, "previous" restarts the current track. Convention
 * shared with Spotify, Apple Music, and YouTube.
 */
export const PREVIOUS_RESTART_THRESHOLD_MS = 3_000;

/**
 * Custom protocol scheme for serving local files to the renderer.
 * Registered as privileged in electron/main/index.ts before app ready.
 *
 * The renderer can't read the filesystem (sandbox: true, nodeIntegration:
 * false), so the local adapter sets <audio>/<video>.src to a URL of
 * shape `musaic-file:///path/to/file.mp3` and main streams the bytes via
 * net.fetch(file://...).
 */
export const LOCAL_FILE_PROTOCOL = 'musaic-file';
