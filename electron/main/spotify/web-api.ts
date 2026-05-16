/**
 * Spotify Web API track-metadata client.
 *
 * One call: `GET /v1/tracks/{id}` with a Bearer access token. Used by
 * the paste-and-save pipeline to capture title, artists, album,
 * duration, artwork, and ISRC at save time. The saved row is the
 * source of truth from then on — we don't proactively refresh on
 * launch (same policy as YouTube paste-and-save rows).
 *
 * Three categorized failure modes plus the network-failure catch:
 *
 *   - 404 → 'not-found'      (deleted or never existed)
 *   - 401 → 'auth-required'  (token revoked or expired in flight)
 *   - 429 → 'rate-limited'   (Spotify is throttling us)
 *   - anything else / fetch throw → 'network'
 *
 * The categorization seam matches the `SpotifySaveOutput`
 * discriminated kinds — the IPC handler upstream maps these to the
 * outbound result without needing to introspect HTTP details.
 */
import { z } from 'zod';

const TRACKS_ENDPOINT = 'https://api.spotify.com/v1/tracks';

/**
 * The fraction of the Spotify Web API track response we consume. The
 * endpoint returns far more (popularity, explicit, available_markets,
 * preview_url, …); we only pull the fields the library row needs.
 * `.passthrough()` so unknown keys don't fail the parse.
 *
 * Image sizing: Spotify documents three sizes (640, 300, 64). We
 * prefer the middle one — sized right for the library tile artwork
 * without burning bandwidth on the 640px hero size.
 */
const imageSchema = z.object({
  url: z.string(),
  height: z.number().int().positive().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
});

const artistSchema = z.object({
  name: z.string(),
});

const trackResponseSchema = z
  .object({
    name: z.string(),
    artists: z.array(artistSchema).nonempty(),
    album: z
      .object({
        name: z.string(),
        images: z.array(imageSchema),
      })
      .passthrough(),
    duration_ms: z.number().int().nonnegative(),
    external_ids: z
      .object({
        isrc: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SpotifyTrackMetadata = {
  readonly trackId: string;
  readonly uri: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string;
  readonly durationMs: number;
  readonly artworkUrl?: string;
  readonly isrc?: string;
};

export type SpotifyTrackErrorReason =
  | 'not-found'
  | 'auth-required'
  | 'rate-limited'
  | 'network';

/**
 * Categorized failure. Mirrors `YouTubeUnplayableError`'s shape for
 * symmetry — sites that handle both sources can branch on `reason`
 * without importing the class hierarchy.
 */
export class SpotifyTrackError extends Error {
  readonly reason: SpotifyTrackErrorReason;
  readonly trackId: string;

  constructor(trackId: string, reason: SpotifyTrackErrorReason, message: string) {
    super(`spotify: track ${trackId} — ${message}`);
    this.name = 'SpotifyTrackError';
    this.trackId = trackId;
    this.reason = reason;
  }
}

/**
 * Indirection seam: production passes `globalThis.fetch`; tests inject
 * a stub. Same pattern as electron/main/youtube/oembed.ts FetchLike.
 */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Pick the "medium" image from the artwork array (Spotify returns
 * sizes 640 / 300 / 64 by convention). Falls back to whatever's
 * present if the conventional triple is missing.
 *
 * Selection algorithm:
 *   1. Find the image whose `width` is closest to 300 but ≥ 64.
 *   2. If no widths are populated, return the middle entry by index.
 *   3. If the array is empty, return undefined.
 *
 * Returning undefined (rather than an empty string) lets the caller
 * spread-omit on the resulting object literal under
 * `exactOptionalPropertyTypes`.
 */
const pickMediumImage = (
  images: ReadonlyArray<{ url: string; width?: number | null | undefined }>,
): string | undefined => {
  if (images.length === 0) return undefined;

  // Filter to images with a usable width; fall back to index-based
  // selection if none.
  const withWidth = images.filter(
    (im): im is { url: string; width: number } =>
      typeof im.width === 'number' && im.width > 0,
  );

  if (withWidth.length === 0) {
    // No widths — pick the middle index. For Spotify's standard
    // 3-image response this is the medium size in practice.
    return images[Math.floor(images.length / 2)]?.url;
  }

  // Apply the MIN filter first. If every image is below MIN (tiny
  // grid thumbnails only — uncommon, but Spotify has shipped 64-only
  // responses before), fall back to the largest of the lot rather
  // than refusing artwork.
  const TARGET = 300;
  const MIN = 64;
  const eligible = withWidth.filter((im) => im.width >= MIN);
  if (eligible.length === 0) {
    // Largest available — sort by width descending and take the first.
    const sorted = [...withWidth].sort((a, b) => b.width - a.width);
    return sorted[0]?.url;
  }

  // Pick the entry whose width is closest to 300.
  let best = eligible[0];
  if (best === undefined) return undefined; // unreachable, TS-pleasing
  let bestDelta = Math.abs(best.width - TARGET);
  for (const im of eligible) {
    const delta = Math.abs(im.width - TARGET);
    if (delta < bestDelta) {
      best = im;
      bestDelta = delta;
    }
  }
  return best.url;
};

/**
 * Fetch metadata for a Spotify track. See `SpotifyTrackError` for
 * categorized failures; happy-path returns the canonical metadata
 * shape consumed by the save pipeline.
 *
 * `trackId` is trusted (parsed by `parseSpotifyTrackInput` upstream);
 * we still URL-encode it for defense-in-depth.
 */
export async function fetchTrackMetadata(
  trackId: string,
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SpotifyTrackMetadata> {
  const url = `${TRACKS_ENDPOINT}/${encodeURIComponent(trackId)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new SpotifyTrackError(
      trackId,
      'network',
      `fetch failed: ${reason}`,
    );
  }

  // Status-first dispatch. Spotify's documented response codes for
  // this endpoint that we care about: 200 (success), 401 (token
  // problem), 404 (no such track), 429 (rate limit). Anything else
  // collapses to `'network'` — it's almost certainly a transient
  // server-side issue we'd retry by hand.
  if (response.status === 404) {
    throw new SpotifyTrackError(trackId, 'not-found', 'HTTP 404');
  }
  if (response.status === 401) {
    throw new SpotifyTrackError(trackId, 'auth-required', 'HTTP 401');
  }
  if (response.status === 429) {
    throw new SpotifyTrackError(trackId, 'rate-limited', 'HTTP 429');
  }
  if (!response.ok) {
    throw new SpotifyTrackError(
      trackId,
      'network',
      `HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new SpotifyTrackError(
      trackId,
      'network',
      `invalid JSON: ${reason}`,
    );
  }

  const parsed = trackResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new SpotifyTrackError(
      trackId,
      'network',
      `unexpected response shape: ${parsed.error.message}`,
    );
  }

  const { name, artists, album, duration_ms, external_ids } = parsed.data;
  const artworkUrl = pickMediumImage(album.images);
  const isrc = external_ids?.isrc;

  return {
    trackId,
    uri: `spotify:track:${trackId}`,
    title: name,
    artists: artists.map((a) => a.name),
    album: album.name,
    durationMs: duration_ms,
    ...(artworkUrl !== undefined && { artworkUrl }),
    ...(isrc !== undefined && { isrc }),
  };
}

// --- Playlist track fetch ------------------------------------

/**
 * Spotify's playlist-track endpoint allows 100 items per page; the
 * page count is hard-capped at 100 here (10,000 tracks max — equal
 * to Spotify's own playlist size ceiling). A playlist hitting the
 * cap returns successfully with `truncated: true` rather than
 * failing — same intent as the YouTube embed-restricted save: better
 * to surface partial results than nothing.
 *
 * Album fetches reuse the same cap. Albums are capped at
 * around 100 tracks by Spotify in practice (deluxe editions ~50, box
 * sets occasionally more); `truncated` will almost never fire for
 * albums but the field stays in the response shape for consistency.
 */
const PLAYLIST_TRACKS_LIMIT = 100;
const PLAYLIST_PAGE_CAP = 100;

/**
 * Fields parameter handed to the playlist-tracks endpoint. Bounds
 * the response payload — Spotify defaults to the full track shape
 * (popularity, available_markets, audio features, etc.) which is
 * many KB per item. We need only the subset the library row consumes.
 *
 * Top-level `next` is the pagination cursor. `items[*].added_at` is
 * read so that — if a future decision flips on it — we don't have to
 * re-issue a paginate pass; the current import-time-based added_at
 * decision makes it unused now.
 * `items[*].is_local` mirrors `items[*].track.is_local`; both surface
 * the "user-uploaded local file" flag and both are checked because
 * Spotify's docs disagree about which one is authoritative.
 */
const PLAYLIST_FIELDS =
  'next,items(added_at,is_local,track(id,uri,name,artists(name),album(name,images),duration_ms,is_local,external_ids))';

/**
 * Single playlist-track item as returned by Spotify, after the
 * `fields` projection. Some fields are nullable (`track` itself can
 * be null for tombstoned items the original creator added before
 * removal from the catalog).
 *
 * Declared locally rather than imported from a community-typed
 * package (per slice conventions: "no new community-typed package").
 * `.passthrough()` so unknown keys don't fail; Spotify's API gains
 * fields over time and a strict schema would brittle-fail on those.
 */
const playlistItemSchema = z
  .object({
    added_at: z.string().nullable().optional(),
    is_local: z.boolean().optional(),
    track: z
      .object({
        id: z.string().nullable(),
        uri: z.string(),
        name: z.string(),
        artists: z.array(artistSchema).nonempty(),
        album: z
          .object({
            name: z.string(),
            images: z.array(imageSchema),
          })
          .passthrough(),
        duration_ms: z.number().int().nonnegative(),
        is_local: z.boolean().optional(),
        external_ids: z
          .object({ isrc: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const playlistPageSchema = z
  .object({
    next: z.string().nullable(),
    items: z.array(playlistItemSchema),
  })
  .passthrough();

export type PlaylistImportResult = {
  readonly tracks: readonly SpotifyTrackMetadata[];
  readonly skipped: number;
  readonly truncated: boolean;
};

/**
 * Optional per-page callback for the save-layer pipeline. Called
 * after each page's tracks are decoded but before the next page is
 * requested; the save layer uses it to upsert the page's rows and
 * broadcast `library:changed` so the user sees Recently Added
 * populate incrementally as a long import runs.
 *
 * Page boundaries here are the same as the API's page boundaries —
 * 100 tracks per call to Spotify, 100 tracks per callback invocation
 * (except possibly the final page, which can be partial).
 *
 * The callback receives only the playable tracks from the page;
 * `is_local` and tombstoned items are filtered out upstream and
 * contribute to the final `skipped` total instead.
 */
export type OnPageDecoded = (
  pageTracks: readonly SpotifyTrackMetadata[],
  pageIndex: number,
) => void | Promise<void>;

/**
 * Sleep helper. Used for the 429 Retry-After back-off. `setTimeout`
 * is wrapped here so it can be replaced in tests via fake timers (or,
 * cheaper, by injecting a no-op alternative).
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Parse the Retry-After header. Spotify documents it as integer
 * seconds; we accept that shape only (RFC-format HTTP dates are also
 * valid per spec but Spotify doesn't use them). Returns the delay in
 * ms, capped at 30s to avoid arbitrary client hangs from a server
 * misconfiguration. Missing / unparseable header → default 1s, which
 * is the minimum we'd back off anyway.
 */
const RETRY_AFTER_CAP_MS = 30_000;
const RETRY_AFTER_DEFAULT_MS = 1_000;
const parseRetryAfter = (response: Response): number => {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return RETRY_AFTER_DEFAULT_MS;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
};

// --- Shared pagination helper ---------------------------------

/**
 * Authenticated GET + categorized-failure path. Used by every Spotify
 * Web API call this module makes that needs the same error mapping:
 *
 *   - 404 → 'not-found'      (resource deleted / inaccessible)
 *   - 401 → 'auth-required'  (token expired or revoked in-flight)
 *   - 429 → respect Retry-After, sleep, retry once. Second 429 →
 *           'rate-limited'.
 *   - other non-OK / fetch throw / invalid JSON → 'network'
 *
 * Returns the parsed JSON body as `unknown` — schema validation is
 * the caller's job, because each endpoint has a different shape.
 * `label` is what `SpotifyTrackError.trackId` carries (playlistId,
 * albumId, etc.); `context` is woven into the error message
 * ("page 3", "bootstrap", …).
 *
 * Shared between `fetchPlaylistTracks` and the album fetcher so
 * both reuse the same retry/error machinery. The shape is
 * intentionally tight — auth +
 * retry + status mapping — and stops short of schema-parsing the
 * body, because that varies per endpoint.
 */
const authenticatedGetJson = async (
  url: string,
  accessToken: string,
  fetchImpl: FetchLike,
  label: string,
  context: string,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new SpotifyTrackError(
      label,
      'network',
      `fetch failed on ${context}: ${reason}`,
    );
  }

  // 429 retry path — honor Retry-After, sleep, retry once. Any
  // second 429 collapses to rate-limited (the IPC handler will
  // translate it to 'network-error' for the renderer to retry).
  if (response.status === 429) {
    const delayMs = parseRetryAfter(response);
    await sleep(delayMs);
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new SpotifyTrackError(
        label,
        'network',
        `fetch failed on retry of ${context}: ${reason}`,
      );
    }
    if (response.status === 429) {
      throw new SpotifyTrackError(
        label,
        'rate-limited',
        `HTTP 429 after Retry-After on ${context}`,
      );
    }
  }

  if (response.status === 404) {
    throw new SpotifyTrackError(
      label,
      'not-found',
      `HTTP 404 on ${context}`,
    );
  }
  if (response.status === 401) {
    throw new SpotifyTrackError(
      label,
      'auth-required',
      `HTTP 401 on ${context}`,
    );
  }
  if (!response.ok) {
    throw new SpotifyTrackError(
      label,
      'network',
      `HTTP ${response.status} on ${context}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    throw new SpotifyTrackError(
      label,
      'network',
      `invalid JSON on ${context}: ${reason}`,
    );
  }
  return body;
};

/**
 * Per-item extraction outcome. Returned by an endpoint-specific
 * extractor that knows how to read a single `items[]` entry. Either
 * the item produced a playable track (`'track'`) or it was filtered
 * out (`'skip'`) and contributes to the final `skipped` total. The
 * extractor is the only place that knows the item's wire shape —
 * playlist items wrap the track under `.track`, album items ARE the
 * track. Both flavors normalize to `SpotifyTrackMetadata` here.
 */
type ExtractedItem =
  | { readonly kind: 'track'; readonly meta: SpotifyTrackMetadata }
  | { readonly kind: 'skip' };

/**
 * Generic paginated decode of a Spotify list of items. Walks `next`
 * URLs until exhaustion or the page cap, calling the per-page
 * `onPageDecoded` hook with the playable tracks of each page.
 *
 * The first page can either be fetched here (pass an `initialUrl`)
 * or supplied pre-fetched (pass `initialPage` — used by the album
 * fetcher, whose bootstrap response wraps the first page under
 * `tracks.items` / `tracks.next`). Subsequent pages are fetched via
 * the `next` URL using `pageSchema` for validation.
 *
 * Skipped items are counted toward the final `skipped` total.
 * Page-cap exhaustion sets `truncated: true`.
 */
async function paginatePages<TItem>(
  args: {
    readonly accessToken: string;
    readonly fetchImpl: FetchLike;
    readonly label: string;
    readonly pageSchema: z.ZodType<{
      readonly next: string | null;
      readonly items: readonly TItem[];
    }>;
    readonly extractItem: (item: TItem) => ExtractedItem;
    readonly onPageDecoded: OnPageDecoded | undefined;
  } & (
    | { readonly initialUrl: string; readonly initialPage?: undefined }
    | {
        readonly initialUrl?: undefined;
        readonly initialPage: {
          readonly items: readonly TItem[];
          readonly next: string | null;
        };
      }
  ),
): Promise<PlaylistImportResult> {
  const {
    accessToken,
    fetchImpl,
    label,
    pageSchema,
    extractItem,
    onPageDecoded,
  } = args;

  const tracks: SpotifyTrackMetadata[] = [];
  let skipped = 0;
  let truncated = false;
  let pageIndex = 0;
  let nextUrl: string | null;

  // Process the first page. Either we already have it (album
  // bootstrap path) or we fetch it via `initialUrl`.
  let currentPage: {
    readonly items: readonly TItem[];
    readonly next: string | null;
  };
  if (args.initialPage !== undefined) {
    currentPage = args.initialPage;
  } else {
    const body = await authenticatedGetJson(
      args.initialUrl,
      accessToken,
      fetchImpl,
      label,
      `page ${pageIndex}`,
    );
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) {
      throw new SpotifyTrackError(
        label,
        'network',
        `unexpected response shape on page ${pageIndex}: ${parsed.error.message}`,
      );
    }
    currentPage = parsed.data;
  }

  while (true) {
    if (pageIndex >= PLAYLIST_PAGE_CAP) {
      // The cap protects against a misbehaving response that loops
      // `next` forever; in practice playlists max at 10k and albums
      // top out near 100.
      truncated = true;
      break;
    }

    const pageTracks: SpotifyTrackMetadata[] = [];
    for (const item of currentPage.items) {
      const extracted = extractItem(item);
      if (extracted.kind === 'skip') {
        skipped += 1;
        continue;
      }
      pageTracks.push(extracted.meta);
    }

    tracks.push(...pageTracks);

    // Fire the per-page hook for the save layer. Awaited so the
    // save layer's upsert + broadcast completes before we ask
    // Spotify for the next page — keeps the user-visible Recently
    // Added population in order, and lets the save layer apply
    // back-pressure if it ever needs to.
    if (onPageDecoded !== undefined) {
      await onPageDecoded(pageTracks, pageIndex);
    }

    nextUrl = currentPage.next;
    pageIndex += 1;
    if (nextUrl === null) break;

    if (pageIndex >= PLAYLIST_PAGE_CAP) {
      truncated = true;
      break;
    }

    const body = await authenticatedGetJson(
      nextUrl,
      accessToken,
      fetchImpl,
      label,
      `page ${pageIndex}`,
    );
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) {
      throw new SpotifyTrackError(
        label,
        'network',
        `unexpected response shape on page ${pageIndex}: ${parsed.error.message}`,
      );
    }
    currentPage = parsed.data;
  }

  return { tracks, skipped, truncated };
}

// --- Playlist track fetch ------------------------------------------------

/**
 * Per-playlist-item extractor. Filters tombstoned (`track: null`),
 * `is_local: true`, and `track.id === null` items; normalizes the
 * remainder to `SpotifyTrackMetadata`. Wire shape: each item is
 * wrapped — `{ added_at, is_local, track: { … } | null }`.
 */
const extractPlaylistItem = (
  item: z.infer<typeof playlistItemSchema>,
): ExtractedItem => {
  // Tombstoned: Spotify removed the track from the catalog.
  // Surfaces as `track: null` in the response; we can't even
  // attempt playback. Counts as skipped, not an error.
  if (item.track === null) return { kind: 'skip' };

  // is_local: user-uploaded local file on the playlist owner's
  // machine. Not playable via the Web SDK (no audio stream).
  // Spotify sets is_local in two places (the item wrapper and
  // the track object); check both for safety.
  if (item.is_local === true || item.track.is_local === true) {
    return { kind: 'skip' };
  }

  const t = item.track;
  // The track might lack an id (e.g. local items that slip
  // through the is_local filter). Defensive skip rather than
  // letting `null` reach the upsert.
  if (t.id === null) return { kind: 'skip' };

  const artworkUrl = pickMediumImage(t.album.images);
  const isrc = t.external_ids?.isrc;
  return {
    kind: 'track',
    meta: {
      trackId: t.id,
      // Use the URI Spotify returned (canonical). Already URI form;
      // matches the SpotifyAdapter expectation post-3a-iii.
      uri: t.uri,
      title: t.name,
      artists: t.artists.map((a) => a.name),
      album: t.album.name,
      durationMs: t.duration_ms,
      ...(artworkUrl !== undefined && { artworkUrl }),
      ...(isrc !== undefined && { isrc }),
    },
  };
};

/**
 * Fetch all tracks for a Spotify playlist, paginating until the
 * `next` cursor is null or the 10,000-track cap is hit. Filters
 * tombstoned (`track: null`) and `is_local: true` items out of the
 * returned tracks and counts them as `skipped`.
 *
 * Error mapping mirrors `fetchTrackMetadata`:
 *   - 404 → 'not-found' (playlist deleted, private, or the user's
 *           account can't access it)
 *   - 401 → 'auth-required'
 *   - 429 → respect Retry-After, sleep, retry once. If still 429,
 *           collapse to 'rate-limited' for the IPC handler to
 *           translate into 'network-error'.
 *   - any other non-OK / fetch throw / schema mismatch → 'network'
 *
 * `playlistId` is trusted (already parsed by `parseSpotifyInput`)
 * but URL-encoded defensively.
 *
 * Delegates page iteration, retry, and error mapping to
 * `paginatePages` / `authenticatedGetJson` so the album fetcher can
 * reuse the same machinery. Wire-level
 * behavior unchanged — the existing test suite passes verbatim.
 */
export async function fetchPlaylistTracks(
  playlistId: string,
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
  onPageDecoded?: OnPageDecoded,
): Promise<PlaylistImportResult> {
  // Initial URL. `market=from_token` so Spotify returns
  // region-correct playability for the user's account — without it,
  // region-locked tracks would show as playable then surface the
  // region-locked error at click time.
  const initialUrl =
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks` +
    `?limit=${PLAYLIST_TRACKS_LIMIT}` +
    `&market=from_token` +
    `&fields=${encodeURIComponent(PLAYLIST_FIELDS)}`;

  return paginatePages({
    accessToken,
    fetchImpl,
    label: playlistId,
    pageSchema: playlistPageSchema,
    extractItem: extractPlaylistItem,
    onPageDecoded,
    initialUrl,
  });
}

// --- Album track fetch ----------------------------------------

/**
 * Spotify's album endpoint returns tracks at `limit=50` by default
 * and at most. Most albums fit in a single page; deluxe editions /
 * box sets occasionally paginate. Same shared `PLAYLIST_PAGE_CAP`
 * applies (a misbehaving response that loops forever still bails).
 */
const ALBUM_TRACKS_LIMIT = 50;

/**
 * Per-album-item shape, projected from `/v1/albums/{id}`. Differs
 * from `playlistItemSchema` in one significant way: each `items[]`
 * entry IS the track directly — no `{ track: { … } }` wrapper, no
 * `added_at`, no playlist-owner-attached `is_local` (albums have no
 * local-file mode). Album tracks also lack a top-level `album`
 * object — that information lives on the parent album response.
 *
 * Album track objects DO carry `is_playable` (a region-gating
 * boolean): when `market=from_token` is applied, Spotify sets
 * `is_playable: false` on tracks the user's region can't stream.
 * Treated as skipped — mirroring the playlist `is_local`
 * convention. (Region-restricted playlist items hit a different
 * filter; their `track` field stays populated, so this asymmetry
 * is purely Spotify's response-shape choice.)
 *
 * `external_ids.isrc` is included on album-track objects when the
 * album response is fetched through `/v1/albums/{id}` (it isn't in
 * the lighter `/v1/albums/{id}/tracks` response — but we don't use
 * that path; see decision 8 in the slice prompt).
 */
const albumItemSchema = z
  .object({
    id: z.string().nullable(),
    uri: z.string(),
    name: z.string(),
    artists: z.array(artistSchema).nonempty(),
    duration_ms: z.number().int().nonnegative(),
    is_playable: z.boolean().optional(),
    external_ids: z
      .object({ isrc: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Shape of the paginated track-list inside an album response.
 * Spotify nests this under `tracks` on the top-level `/v1/albums/{id}`
 * call; subsequent pages (followed via `tracks.next`) hit
 * `/v1/albums/{id}/tracks` and return THIS shape at the top level.
 * The shared paginator handles both — bootstrap unwraps `tracks`,
 * the iterator uses this schema for `next` pages.
 */
const albumTracksPageSchema = z
  .object({
    next: z.string().nullable(),
    items: z.array(albumItemSchema),
  })
  .passthrough();

/**
 * Bootstrap response shape for `/v1/albums/{id}`. We pull the album
 * name + images so album-track records get the parent album's title
 * and artwork (each item lacks its own). `tracks` is the first page
 * of the paginated track list.
 *
 * `.passthrough()` so the many fields we ignore (artists, label,
 * release_date, popularity, copyrights, …) don't fail the parse.
 */
const albumBootstrapSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    images: z.array(imageSchema),
    tracks: albumTracksPageSchema,
  })
  .passthrough();

/**
 * Per-album-item extractor. Filters region-unplayable tracks
 * (`is_playable: false`) and id-less items. Normalizes to
 * `SpotifyTrackMetadata` — pulling album name + artwork from
 * closure-captured parent-album values rather than from the item
 * itself.
 *
 * Returned as a factory because the album name + artwork come from
 * outside the per-item schema (the bootstrap response).
 */
const makeExtractAlbumItem = (
  albumName: string,
  albumArtworkUrl: string | undefined,
): ((item: z.infer<typeof albumItemSchema>) => ExtractedItem) => {
  return (t) => {
    if (t.is_playable === false) return { kind: 'skip' };
    if (t.id === null) return { kind: 'skip' };

    const isrc = t.external_ids?.isrc;
    return {
      kind: 'track',
      meta: {
        trackId: t.id,
        uri: t.uri,
        title: t.name,
        artists: t.artists.map((a) => a.name),
        album: albumName,
        durationMs: t.duration_ms,
        ...(albumArtworkUrl !== undefined && { artworkUrl: albumArtworkUrl }),
        ...(isrc !== undefined && { isrc }),
      },
    };
  };
};

/**
 * Fetch all tracks for a Spotify album.
 *
 * Endpoint: `/v1/albums/{id}?market=from_token`. The bootstrap
 * response embeds the first page of tracks at `.tracks` and surfaces
 * the album's name + images at the top level — we capture both, then
 * pass the embedded page to the shared paginator with an album-
 * specific extractor that decorates each track with the parent
 * album's name + artwork. Subsequent pages follow `.tracks.next`
 * with the same schema (Spotify returns the unwrapped page shape
 * for `next` URLs).
 *
 * Error mapping mirrors `fetchPlaylistTracks` exactly — same
 * `SpotifyTrackError` reasons, with the album id occupying the
 * `trackId` slot (the field name is historical; it carries whatever
 * label the caller passed to `authenticatedGetJson`).
 *
 * No new OAuth scopes are required — albums are public catalog data
 * accessible with any user-bound token. Album fetches are
 * region-correct via `market=from_token`, same as playlists.
 */
export async function fetchAlbumTracks(
  albumId: string,
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
  onPageDecoded?: OnPageDecoded,
): Promise<PlaylistImportResult> {
  const bootstrapUrl =
    `https://api.spotify.com/v1/albums/${encodeURIComponent(albumId)}` +
    `?market=from_token`;

  const body = await authenticatedGetJson(
    bootstrapUrl,
    accessToken,
    fetchImpl,
    albumId,
    'bootstrap',
  );

  const parsed = albumBootstrapSchema.safeParse(body);
  if (!parsed.success) {
    throw new SpotifyTrackError(
      albumId,
      'network',
      `unexpected album response shape: ${parsed.error.message}`,
    );
  }

  const albumName = parsed.data.name;
  const albumArtworkUrl = pickMediumImage(parsed.data.images);

  return paginatePages({
    accessToken,
    fetchImpl,
    label: albumId,
    pageSchema: albumTracksPageSchema,
    extractItem: makeExtractAlbumItem(albumName, albumArtworkUrl),
    onPageDecoded,
    initialPage: parsed.data.tracks,
  });
}

// `ALBUM_TRACKS_LIMIT` is the page-size hint, but Spotify defaults
// to 20 on `/v1/albums/{id}` if no override is supplied. We rely on
// the default since the constant exists only to document the cap
// (50). The follow-up pagination respects whatever `next` URL
// Spotify constructs. Reserved for a future explicit-limit override
// if the default ever shrinks.
void ALBUM_TRACKS_LIMIT;
