import type { AdapterFactory, PlaybackAdapter, Source } from './types';
import { LocalAdapter } from '@renderer/adapters/local/local-adapter';
import { YouTubeAdapter } from '@renderer/adapters/youtube/youtube-adapter';
import { SpotifyAdapter } from '@renderer/adapters/spotify/spotify-adapter';
import { MockSpotifyAdapter } from '@renderer/adapters/spotify/mock-spotify-adapter';

/**
 * Module-level constant for the Spotify adapter constructor —
 * locked at build time. Vite replaces `import.meta.env.PROD` at
 * build time, so the conditional resolves to either
 * `SpotifyAdapter` or `MockSpotifyAdapter` at the module's top
 * level. Rollup's tree-shaking then drops the unused class from
 * the production bundle (verified at packaging time per the slice
 * prompt: `grep -l MockSpotifyAdapter out/renderer/*.js` should
 * return empty).
 *
 * Why a module-level constant rather than an inline ternary inside
 * `createAdapter`: inline tree-shaking is brittle — Rollup needs to
 * see the unused class as truly unreferenced, and putting the choice
 * inside a function body can keep the reference live in some
 * configurations. The constant pattern is the same one used by
 * Vite's own internal env switches.
 *
 * real, env-gated at build time".
 */
const SpotifyAdapterCtor = import.meta.env.PROD
  ? SpotifyAdapter
  : MockSpotifyAdapter;

/**
 * Production adapter factory. Returns a fresh adapter instance per call;
 * PlayerManager allocates one per loaded track and disposes via unload().
 *
 * Spotify case: returns the real `SpotifyAdapter` in
 * production builds, the `MockSpotifyAdapter` in dev. The switch is
 * compile-time via `import.meta.env.PROD`; see `SpotifyAdapterCtor`
 * above.
 */
export const createAdapter: AdapterFactory = (source: Source): PlaybackAdapter => {
  switch (source) {
    case 'local':
      return new LocalAdapter();
    case 'youtube':
      return new YouTubeAdapter();
    case 'spotify':
      return new SpotifyAdapterCtor();
    default: {
      const _exhaustive: never = source;
      throw new Error(`createAdapter: unknown source ${String(_exhaustive)}`);
    }
  }
};
