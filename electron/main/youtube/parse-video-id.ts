/**
 * Extract a YouTube video ID from a user-supplied URL or bare ID string.
 *
 * Duplicated from `src/adapters/youtube/parse-video-id.ts` because
 * electron/ (main) and src/ (renderer) are bundled by separate
 * tsconfigs and can't cross-import. Same convention as the
 * PLAYABLE_EXTENSIONS set duplicated across electron/main/index.ts,
 * electron/main/library/import.ts, and electron/main/library/watcher.ts
 * — pure utility, keep the two copies in sync.
 *
 * If this drifts: the tests in both halves cover the same input
 * shapes, so a divergence would surface. The implementation is small
 * enough that re-syncing is a one-pass edit.
 */

/** YouTube video IDs are exactly 11 characters from [A-Za-z0-9_-]. */
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const isValidVideoId = (s: string): boolean => VIDEO_ID_REGEX.test(s);

const tryBareId = (input: string): string | null => {
  const trimmed = input.trim();
  return isValidVideoId(trimmed) ? trimmed : null;
};

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
 * Returns null for anything else.
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

  const host = url.hostname.replace(/^(www\.|m\.)/, '');

  if (host === 'youtu.be') {
    const id = firstNonEmptySegment(url.pathname);
    return id !== null && isValidVideoId(id) ? id : null;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      return v !== null && isValidVideoId(v) ? v : null;
    }
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
