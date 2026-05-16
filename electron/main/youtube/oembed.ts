/**
 * YouTube oEmbed client.
 *
 * Fetches `https://www.youtube.com/oembed?url=<watch>&format=json` to
 * get title, uploader (channel), and thumbnail for a videoId. No auth,
 * no API key — oEmbed is a public endpoint.
 *
 * Three outcomes that callers care about, captured in the return type:
 *
 *   - `ok`               — full metadata; the save persists the row.
 *   - `not-found`        — HTTP 404. Video is deleted, private, or the
 *                          videoId is malformed and youtube doesn't
 *                          know it.
 *   - `embed-restricted` — HTTP 401. Video exists but the uploader has
 *                          disabled embedding. oEmbed returns 401 with
 *                          an "Unauthorized" body in this case (yes,
 *                          really — non-obvious mapping from the
 *                          oEmbed spec, but it's what youtube serves).
 *                          The save still persists with placeholder
 *                          metadata.
 *
 * Anything else (network failure, 5xx, malformed JSON, JSON that
 * doesn't match the schema) throws a `youtube: oembed failed for
 * videoId X — Y` error so the IPC handler can surface it.
 *
 * Duration is not in the oEmbed response. The save records 0 for
 * duration_ms; PlayerManager's locked behavior is to override
 * `track.durationMs` with `adapter.getDurationMs()` once the YouTube
 * adapter loads the video, so the scrubber becomes correct on first
 * play (`getDurationMs()` from the adapter is authoritative).
 */
import { z } from 'zod';

const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';

/**
 * The oEmbed response shape we care about. The endpoint returns a
 * larger object (width, height, html, version, …) but we only consume
 * three fields. `.passthrough()` so unknown keys don't fail the parse.
 */
const oembedResponseSchema = z.object({
  title: z.string(),
  author_name: z.string(),
  thumbnail_url: z.string(),
}).passthrough();

export type YouTubeMetadata = {
  readonly title: string;
  readonly channel: string;
  readonly thumbnailUrl: string;
};

export type FetchOEmbedResult =
  | { readonly kind: 'ok'; readonly metadata: YouTubeMetadata }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'embed-restricted' };

/**
 * Indirection seam: production passes `globalThis.fetch`; tests inject
 * a stub. Keeping the fetch as a parameter rather than calling
 * `fetch()` directly lets the unit test mock the network without
 * touching `globalThis`.
 */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Fetch oEmbed metadata for a videoId. See FetchOEmbedResult for the
 * outcome shape and the module-level comment for the 404 vs 401
 * distinction.
 *
 * `videoId` is trusted (parsed by parseYouTubeVideoId upstream); we
 * still URL-encode for defense-in-depth.
 */
export async function fetchYouTubeMetadata(
  videoId: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<FetchOEmbedResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const oembedUrl = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(watchUrl)}&format=json`;

  let response: Response;
  try {
    response = await fetchImpl(oembedUrl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new Error(
      `youtube: oembed failed for videoId ${videoId} — network error: ${reason}`,
    );
  }

  // Status-first dispatch. 404 / 401 are the documented outcomes;
  // everything else is a genuine failure we surface.
  if (response.status === 404) {
    return { kind: 'not-found' };
  }
  if (response.status === 401) {
    return { kind: 'embed-restricted' };
  }
  if (!response.ok) {
    throw new Error(
      `youtube: oembed failed for videoId ${videoId} — HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new Error(
      `youtube: oembed failed for videoId ${videoId} — invalid JSON: ${reason}`,
    );
  }

  const parsed = oembedResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `youtube: oembed failed for videoId ${videoId} — unexpected response shape: ${parsed.error.message}`,
    );
  }

  return {
    kind: 'ok',
    metadata: {
      title: parsed.data.title,
      channel: parsed.data.author_name,
      thumbnailUrl: parsed.data.thumbnail_url,
    },
  };
}
