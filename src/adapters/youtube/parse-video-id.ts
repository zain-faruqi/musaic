/**
 * Extract a YouTube video ID from a user-supplied URL or bare ID string.
 *
 * Why a regex rather than parsing the URL alone: YouTube's URL shapes
 * mix path-segment IDs (`/shorts/<id>`, `youtu.be/<id>`) with query-param
 * IDs (`?v=<id>`), and each form has trailing-garbage variants (extra
 * `?t=…` fragments, `&feature=…`, /embed/ paths, etc). A URL parse plus
 * a strict 11-char ID regex at the end handles all of them with a single
 * validation rule.
 *
 * The 11-character / `[A-Za-z0-9_-]+` shape is YouTube's documented ID
 * format and has been stable for over a decade. We don't try to be
 * cleverer than that — if the extractor lands on something that doesn't
 * match, we reject rather than guess.
 */

/** YouTube video IDs are exactly 11 characters from [A-Za-z0-9_-]. */
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const isValidVideoId = (s: string): boolean => VIDEO_ID_REGEX.test(s);

/**
 * Try the bare-string-is-already-an-ID case before URL parsing. Users
 * who copy "dQw4w9WgXcQ" out of a podcast notes file should get the
 * same answer as users who paste the full URL.
 */
const tryBareId = (input: string): string | null => {
  const trimmed = input.trim();
  return isValidVideoId(trimmed) ? trimmed : null;
};

/**
 * Strip the leading slash and pull the first path segment, which is
 * where path-based forms (`youtu.be/<id>`, `/shorts/<id>`, `/embed/<id>`,
 * `/v/<id>`) put the ID.
 */
const firstNonEmptySegment = (pathname: string, skip = 0): string | null => {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  return segments[skip] ?? null;
};

/**
 * Extract a video ID. Accepts:
 *   - A bare ID: "dQw4w9WgXcQ"
 *   - youtube.com/watch?v=<id>            (and m.youtube.com, www.)
 *   - youtu.be/<id>
 *   - youtube.com/shorts/<id>
 *   - youtube.com/embed/<id>
 *   - youtube.com/v/<id>
 *   - youtube-nocookie.com/embed/<id>
 *
 * Returns null for anything else, including:
 *   - Non-YouTube hosts
 *   - YouTube URLs without a recognizable video ID (channel pages,
 *     playlists without a `v` param, the bare homepage)
 *   - Malformed strings that won't parse as URLs and aren't bare IDs
 */
export const parseYouTubeVideoId = (input: string): string | null => {
  if (typeof input !== 'string' || input.length === 0) return null;

  const asBareId = tryBareId(input);
  if (asBareId !== null) return asBareId;

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  // Normalize host: drop the leading "www." or "m." so the switch below
  // only deals with the canonical name. youtube-nocookie.com is also
  // valid (embedded mode); both are accepted.
  const host = url.hostname.replace(/^(www\.|m\.)/, '');

  if (host === 'youtu.be') {
    // The path itself is the ID: /<id>[/maybe-extra]
    const id = firstNonEmptySegment(url.pathname);
    return id !== null && isValidVideoId(id) ? id : null;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    // /watch?v=<id>
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      return v !== null && isValidVideoId(v) ? v : null;
    }
    // /shorts/<id>, /embed/<id>, /v/<id> all put the ID in the second
    // path segment.
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const head = segments[0];
    const tail = segments[1];
    if (
      tail !== undefined &&
      (head === 'shorts' || head === 'embed' || head === 'v') &&
      isValidVideoId(tail)
    ) {
      return tail;
    }
    return null;
  }

  return null;
};
