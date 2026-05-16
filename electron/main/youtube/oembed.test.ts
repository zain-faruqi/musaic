/**
 * Tests for the oEmbed client. The actual HTTPS call to
 * youtube.com/oembed isn't reachable in Vitest's node environment
 * (we don't want a test suite that hits the live network); the
 * fetch boundary is the seam.
 *
 * The function-parameter fetch seam (`FetchLike` injected at call
 * site) is what makes this testable without monkey-patching
 * `globalThis.fetch`.
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchYouTubeMetadata, type FetchLike } from './oembed';

/**
 * Build a fake fetch that returns a canned Response. Body and status
 * are configurable; everything else is the default Response shape.
 */
const fakeFetch = (config: {
  status: number;
  body?: unknown;
  bodyString?: string;
  throws?: boolean;
}): FetchLike => {
  return vi.fn(async (): Promise<Response> => {
    if (config.throws) throw new Error('network down');
    const init: ResponseInit = { status: config.status };
    if (config.bodyString !== undefined) {
      return new Response(config.bodyString, init);
    }
    if (config.body !== undefined) {
      return new Response(JSON.stringify(config.body), {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, init);
  });
};

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('fetchYouTubeMetadata', () => {
  it('returns ok with parsed metadata on 200', async () => {
    const fetch = fakeFetch({
      status: 200,
      body: {
        title: 'Never Gonna Give You Up',
        author_name: 'Rick Astley',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        // Unknown fields in the real response — verify .passthrough()
        // doesn't reject them.
        width: 480,
        height: 270,
        html: '<iframe>…</iframe>',
        version: '1.0',
      },
    });
    const result = await fetchYouTubeMetadata(VIDEO_ID, fetch);
    expect(result).toEqual({
      kind: 'ok',
      metadata: {
        title: 'Never Gonna Give You Up',
        channel: 'Rick Astley',
        thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      },
    });
  });

  it('returns not-found on 404', async () => {
    const fetch = fakeFetch({ status: 404 });
    const result = await fetchYouTubeMetadata(VIDEO_ID, fetch);
    expect(result).toEqual({ kind: 'not-found' });
  });

  it('returns embed-restricted on 401', async () => {
    // The non-obvious mapping: oEmbed returns 401 "Unauthorized" for
    // embed-disabled videos. See module-level comment in oembed.ts.
    const fetch = fakeFetch({ status: 401, bodyString: 'Unauthorized' });
    const result = await fetchYouTubeMetadata(VIDEO_ID, fetch);
    expect(result).toEqual({ kind: 'embed-restricted' });
  });

  it('throws source-prefixed error on 500', async () => {
    const fetch = fakeFetch({ status: 500 });
    await expect(fetchYouTubeMetadata(VIDEO_ID, fetch)).rejects.toThrow(
      /^youtube: oembed failed for videoId dQw4w9WgXcQ — HTTP 500/,
    );
  });

  it('throws source-prefixed error on network failure', async () => {
    const fetch = fakeFetch({ status: 0, throws: true });
    await expect(fetchYouTubeMetadata(VIDEO_ID, fetch)).rejects.toThrow(
      /^youtube: oembed failed for videoId dQw4w9WgXcQ — network error: network down/,
    );
  });

  it('throws on 200 with invalid JSON', async () => {
    const fetch = fakeFetch({ status: 200, bodyString: 'not json {{' });
    await expect(fetchYouTubeMetadata(VIDEO_ID, fetch)).rejects.toThrow(
      /^youtube: oembed failed for videoId dQw4w9WgXcQ — invalid JSON/,
    );
  });

  it('throws on 200 with JSON missing required fields', async () => {
    // Real oEmbed returns more fields than we read, but the three we
    // do read are required.
    const fetch = fakeFetch({
      status: 200,
      body: { title: 'X' /* missing author_name, thumbnail_url */ },
    });
    await expect(fetchYouTubeMetadata(VIDEO_ID, fetch)).rejects.toThrow(
      /^youtube: oembed failed for videoId dQw4w9WgXcQ — unexpected response shape/,
    );
  });

  it('URL-encodes the videoId in the request URL', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = vi.fn(async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          title: 'X',
          author_name: 'Y',
          thumbnail_url: 'https://i.ytimg.com/vi/X/hqdefault.jpg',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    // Synthetic videoId with characters that would need encoding —
    // not a real videoId shape, but the parser upstream is what
    // guarantees the 11-char form. Here we're testing the encode.
    //
    // Double-encoding is the *correct* behavior: we encode the
    // videoId into the watch URL, then encode the whole watch URL
    // into the `url=` query parameter of the oembed request. The
    // outer URL therefore shows `%252F` (the inner `%2F`'s `%` got
    // encoded to `%25`). To verify the inner shape, parse the outer
    // URL and read `url=` — URLSearchParams.get decodes one layer,
    // leaving us with the watch URL whose `v=` carries the encoded
    // videoId.
    await fetchYouTubeMetadata('a/b?c', fetch);
    const outer = new URL(calls[0]!);
    const innerWatchUrl = outer.searchParams.get('url');
    expect(innerWatchUrl).not.toBeNull();
    // The watch URL's `v=` parameter carries the encoded videoId.
    // It's still encoded in the watch URL's query string because the
    // watch URL is being treated as a string here, not parsed — that
    // matches what YouTube's oembed endpoint actually sees on its end.
    expect(innerWatchUrl).toContain('v=a%2Fb%3Fc');
  });
});
