/**
 * Tests for the YouTube paste-and-save pipeline. Mocks the oEmbed
 * fetch via FetchLike injection — same seam as oembed.test.ts.
 *
 * Each test runs against a fresh in-memory SQLite DB with the
 * post-0002 schema applied, so the upsert paths exercise real SQL.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/runner';
import { getTrack } from '../db/tracks';
import type { FetchLike } from './oembed';
import { saveYouTubeUrl } from './save';

const schemaMigration = {
  version: 1,
  name: 'initial',
  sql: `
    CREATE TABLE tracks (
      source       TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      path         TEXT,
      title        TEXT NOT NULL,
      artists      TEXT NOT NULL,
      album        TEXT,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      isrc         TEXT,
      artwork_url  TEXT,
      mtime        INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (source, source_id)
    );
  `,
};

const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const mockOk = (overrides: Record<string, unknown> = {}): FetchLike =>
  vi.fn(async () =>
    new Response(
      JSON.stringify({
        title: 'Never Gonna Give You Up',
        author_name: 'Rick Astley',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        ...overrides,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

const mockStatus = (status: number): FetchLike =>
  vi.fn(async () => new Response(null, { status }));

describe('saveYouTubeUrl', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    migrate(db, [schemaMigration]);
  });
  afterEach(() => {
    db.close();
  });

  it('saved: upserts a row and returns the track', async () => {
    const result = await saveYouTubeUrl(WATCH_URL, db, 1_700_000_000, mockOk());
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('unreachable');
    expect(result.track).toMatchObject({
      id: `youtube:${VIDEO_ID}`,
      source: 'youtube',
      sourceId: VIDEO_ID,
      title: 'Never Gonna Give You Up',
      artists: ['Rick Astley'],
      durationMs: 0,
      artwork: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
    // refs is a single-element array keying the persisted row. The
    // picker reads it to compute auto-select against the current
    // `availableTracks` pool.
    expect(result.refs).toEqual([
      { source: 'youtube', sourceId: VIDEO_ID },
    ]);
    // Row is in the DB.
    const row = getTrack(db, 'youtube', VIDEO_ID);
    expect(row).toBeDefined();
    expect(row?.title).toBe('Never Gonna Give You Up');
    expect(row?.path).toBeNull();
    expect(row?.duration_ms).toBe(0); // see save.ts — duration filled at first play
    expect(row?.created_at).toBe(1_700_000_000);
  });

  it('not-found: returns the discriminator with no row saved', async () => {
    const result = await saveYouTubeUrl(WATCH_URL, db, 0, mockStatus(404));
    expect(result).toEqual({ kind: 'not-found' });
    expect(getTrack(db, 'youtube', VIDEO_ID)).toBeUndefined();
  });

  it('embed-restricted: saves with placeholder title and null artwork', async () => {
    const result = await saveYouTubeUrl(WATCH_URL, db, 0, mockStatus(401));
    expect(result.kind).toBe('embed-restricted');
    if (result.kind !== 'embed-restricted') throw new Error('unreachable');
    expect(result.track.title).toMatch(/embed-restricted/);
    // No artwork — wire shape omits the field rather than carrying
    // undefined (see toUnifiedTrack and exactOptionalPropertyTypes).
    expect(result.track).not.toHaveProperty('artwork');
    expect(result.track.artists).toEqual([]);
    expect(result.track.source).toBe('youtube');
    expect(result.track.sourceId).toBe(VIDEO_ID);
    // embed-restricted deliberately does NOT carry refs. The
    // picker's paste-to-add callback fires only for fully-successful
    // saves; embed-restricted is a degraded outcome the
    // URL pill signals separately, and auto-selecting an unplayable
    // track into a playlist would be a footgun.
    expect(result).not.toHaveProperty('refs');
    // Row is in the DB.
    const row = getTrack(db, 'youtube', VIDEO_ID);
    expect(row).toBeDefined();
    expect(row?.artwork_url).toBeNull();
    expect(row?.duration_ms).toBe(0);
  });

  it('preserves created_at on re-save (upsert ON CONFLICT)', async () => {
    await saveYouTubeUrl(WATCH_URL, db, 1_000, mockOk());
    const first = getTrack(db, 'youtube', VIDEO_ID);
    expect(first?.created_at).toBe(1_000);
    // Re-save much later — mtime advances, created_at must not.
    await saveYouTubeUrl(WATCH_URL, db, 9_000, mockOk());
    const second = getTrack(db, 'youtube', VIDEO_ID);
    expect(second?.created_at).toBe(1_000);
    expect(second?.mtime).toBe(9_000);
  });

  it('rejects non-YouTube URLs without hitting the network', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('should not be called');
    }) as FetchLike;
    await expect(
      saveYouTubeUrl('https://example.com/not-youtube', db, 0, fetch),
    ).rejects.toThrow(/not a YouTube URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts bare videoIds as well as URLs', async () => {
    const result = await saveYouTubeUrl(VIDEO_ID, db, 0, mockOk());
    expect(result.kind).toBe('saved');
  });

  it('propagates network errors with source prefix from oembed', async () => {
    const fetch: FetchLike = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      saveYouTubeUrl(WATCH_URL, db, 0, fetch),
    ).rejects.toThrow(/^youtube: oembed failed.*ECONNRESET/);
  });
});
