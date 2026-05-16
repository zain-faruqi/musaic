/**
 * Minimal local types for the Spotify Web Playback SDK.
 *
 * Declared locally instead of pulled from `@types/spotify-web-playback-sdk`
 * because the surface we use is small and we prefer locally-declared
 * types over a community-typed devDep. See
 * `src/adapters/youtube/iframe-api-loader.ts` for the analogous shape
 * on the YouTube side.
 *
 * Reference: https://developer.spotify.com/documentation/web-playback-sdk
 */

/**
 * Player state object passed to `player_state_changed` listeners. We
 * read position, duration, paused, and the current_track URI to
 * detect transitions; many other fields exist but we ignore them.
 */
export type SpotifyPlayerState = {
  readonly position: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly track_window: {
    readonly current_track: {
      readonly uri: string;
      readonly id: string | null;
    };
  };
  readonly loading: boolean;
};

/**
 * Event payload variants. All four error events have the same shape
 * (`{ message: string }`); the `ready` / `not_ready` events carry a
 * `device_id`.
 */
export type SpotifyDeviceEvent = { readonly device_id: string };
export type SpotifyErrorEvent = { readonly message: string };

/**
 * Spotify.Player instance — the methods and event shapes we use.
 * Promises returned by play/pause/seek/setVolume resolve to void on
 * success and reject on failure.
 */
export type SpotifyPlayer = {
  connect(): Promise<boolean>;
  disconnect(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  togglePlay(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>; // 0..1
  getCurrentState(): Promise<SpotifyPlayerState | null>;
  /**
   * Bind the player to a user gesture. Required by browser autoplay
   * policy when the renderer's `play()` flow doesn't have a fresh
   * user activation in scope (cross-source handoff from a setInterval
   * tick, for example).
   */
  activateElement(): Promise<void>;

  /**
   * Spotify's event names. Typed as a strict union so consumers get
   * autocomplete + exhaustiveness, and so a mistyped event name is a
   * compile error rather than a silent no-op.
   */
  addListener(
    event: 'ready' | 'not_ready',
    cb: (e: SpotifyDeviceEvent) => void,
  ): boolean;
  addListener(
    event: 'player_state_changed',
    cb: (state: SpotifyPlayerState | null) => void,
  ): boolean;
  addListener(
    event:
      | 'initialization_error'
      | 'authentication_error'
      | 'account_error'
      | 'playback_error',
    cb: (e: SpotifyErrorEvent) => void,
  ): boolean;

  removeListener(
    event:
      | 'ready'
      | 'not_ready'
      | 'player_state_changed'
      | 'initialization_error'
      | 'authentication_error'
      | 'account_error'
      | 'playback_error',
  ): boolean;
};

/**
 * Player constructor config. `getOAuthToken` is the SDK-invoked
 * callback for fresh tokens — the callback fires whenever the SDK
 * needs a token (initial connect, after expiry, etc.). The SDK
 * doesn't cache; we delegate to main via `window.musaic.spotify.getToken()`.
 */
export type SpotifyPlayerConfig = {
  readonly name: string;
  readonly getOAuthToken: (cb: (token: string) => void) => void;
  readonly volume?: number; // 0..1
};

export type SpotifyPlayerConstructor = new (
  config: SpotifyPlayerConfig,
) => SpotifyPlayer;

export type SpotifyGlobal = {
  readonly Player: SpotifyPlayerConstructor;
};

declare global {
  interface Window {
    /** Installed by the Web Playback SDK after the script loads. */
    Spotify?: SpotifyGlobal;
    /**
     * Globally-scoped readiness callback. The SDK invokes this once
     * `window.Spotify` is fully initialized.
     */
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}
