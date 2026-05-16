/**
 * Paste-and-save pipeline for YouTube URLs.
 *
 * Single function rather than IPC-handler-shaped so it's directly
 * testable and the IPC handler stays thin (parse + dispatch + error
 * shaping). Same convention as electron/main/library/import.ts.
 *
 * Flow:
 *   1. Parse videoId from the URL (reject if it's not a YouTube URL).
 *   2. Fetch oEmbed metadata.
 *   3. Branch on the three oEmbed outcomes:
 *      - ok               — upsert with real metadata, return saved
 *      - embed-restricted — upsert with placeholder metadata, return
 *                           embed-restricted (still saved so the user
 *                           can try clicking it, surface the limit at
 *                           click time via the click-time-unplayability
 *                           path)
 *      - not-found        — return not-found, no row saved
 *
 * Errors from fetchYouTubeMetadata propagate (source-prefixed already);
 * the IPC handler surfaces them as rejection.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { LibraryTrack, YouTubeSaveOutput } from '../../ipc/channels';
import { trackRowToUnifiedTrack, type TrackRow } from '../db/schema';
import { upsertTrack, getTrack } from '../db/tracks';
import { parseYouTubeVideoId } from './parse-video-id';
import {
  fetchYouTubeMetadata,
  type FetchLike,
} from './oembed';

const EMBED_RESTRICTED_TITLE_PLACEHOLDER = 'YouTube video (embed-restricted)';

/**
 * Save a YouTube URL to the library.
 *
 * `now` is a parameter (rather than a direct `Date.now()` call) so
 * tests can pin the timestamp. The upsert preserves `created_at` on
 * conflict, so re-saving the same videoId reuses the original
 * timestamp regardless of what we pass here.
 *
 * `fetchImpl` is the oEmbed fetch seam — tests inject a stub.
 */
export async function saveYouTubeUrl(
  url: string,
  db: DatabaseSync,
  now: number = Date.now(),
  fetchImpl?: FetchLike,
): Promise<YouTubeSaveOutput> {
  const videoId = parseYouTubeVideoId(url);
  if (videoId === null) {
    throw new Error(`youtube: not a YouTube URL: ${url}`);
  }

  const result = fetchImpl
    ? await fetchYouTubeMetadata(videoId, fetchImpl)
    : await fetchYouTubeMetadata(videoId);

  if (result.kind === 'not-found') {
    return { kind: 'not-found' };
  }

  // Preserve existing created_at on conflict — upsertTrack handles
  // this via ON CONFLICT DO UPDATE, but we still need to *supply* a
  // value, and for new rows we want it correct. Read the existing row
  // (if any) before computing the row to insert; if present, reuse
  // its created_at. (This mirrors what import.ts does implicitly via
  // ON CONFLICT — the upsert excludes created_at from the update set.)
  const existing = getTrack(db, 'youtube', videoId);
  const createdAt = existing?.created_at ?? now;

  if (result.kind === 'embed-restricted') {
    // Embed-restricted: save with placeholder so the user still sees a
    // tile, can click it, and gets the open-on-youtube affordance.
    // Title placeholder names the constraint so the user understands
    // why the title is generic.
    const row: TrackRow = {
      source: 'youtube',
      source_id: videoId,
      path: null,
      title: EMBED_RESTRICTED_TITLE_PLACEHOLDER,
      artists: JSON.stringify([]),
      album: null,
      duration_ms: 0,
      isrc: null,
      artwork_url: null,
      mtime: now,
      created_at: createdAt,
    };
    upsertTrack(db, row);
    const track: LibraryTrack = trackRowToUnifiedTrack(row);
    return { kind: 'embed-restricted', track };
  }

  // ok — full save.
  const { metadata } = result;
  const row: TrackRow = {
    source: 'youtube',
    source_id: videoId,
    path: null,
    title: metadata.title,
    // oEmbed gives a single `author_name`. We model it as a one-element
    // artists array — same shape as a single-artist local track.
    artists: JSON.stringify([metadata.channel]),
    album: null,
    // oEmbed has no duration. Stored as 0; PlayerManager will override
    // with adapter.getDurationMs() on first play (locked decision).
    duration_ms: 0,
    isrc: null,
    artwork_url: metadata.thumbnailUrl,
    mtime: now,
    created_at: createdAt,
  };
  upsertTrack(db, row);
  const track: LibraryTrack = trackRowToUnifiedTrack(row);
  // Single-element refs array. The shape mirrors bulk
  // imports so the picker's paste-to-add path reads `refs` uniformly
  // across both save flavors.
  return {
    kind: 'saved',
    track,
    refs: [{ source: 'youtube', sourceId: videoId }],
  };
}
