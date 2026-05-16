/**
 * Tests for the renderer-side playlist wrappers and pure helpers.
 *
 * Only `computeAvailableTracks` is exercised here — the IPC wrappers
 * are tested at the boundary in `electron/main/ipc/playlists.test.ts`
 * and via the renderer-side `playlist-store.test.ts` which mocks
 * `window.musaic.playlist`. The helper is pure (no IPC, no store) so
 * it tests in isolation without any rigging.
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedTrack } from '@renderer/core/types';
import type { PlaylistMembership } from '@ipc/contracts';
import { composeInlineMessage, computeAvailableTracks } from './playlists';

const track = (
  id: string,
  source: UnifiedTrack['source'],
  sourceId: string,
): UnifiedTrack => ({
  id,
  source,
  sourceId,
  title: `t-${id}`,
  artists: [],
  durationMs: 0,
});

const member = (
  playlistTrackId: number,
  position: number,
  source: UnifiedTrack['source'],
  sourceId: string,
): PlaylistMembership => ({
  playlistTrackId,
  position,
  track: {
    id: `${source}:${sourceId}`,
    source,
    sourceId,
    title: `m-${playlistTrackId}`,
    artists: [],
    durationMs: 0,
  },
});

describe('computeAvailableTracks', () => {
  it('returns the full library when no tracks are members', () => {
    const lib: readonly UnifiedTrack[] = [
      track('a', 'local', '1'),
      track('b', 'youtube', '2'),
    ];
    expect(computeAvailableTracks(lib, [])).toEqual(lib);
  });

  it('returns empty when every library track is a member', () => {
    const lib: readonly UnifiedTrack[] = [
      track('a', 'local', '1'),
      track('b', 'youtube', '2'),
    ];
    const members: readonly PlaylistMembership[] = [
      member(10, 0, 'local', '1'),
      member(11, 1, 'youtube', '2'),
    ];
    expect(computeAvailableTracks(lib, members)).toEqual([]);
  });

  it('filters by (source, sourceId), not by id alone', () => {
    // Two distinct tracks share `sourceId` but have different
    // `source` — both must be considered separately. This mirrors
    // the unified `tracks` PK (source, sourceId).
    const lib: readonly UnifiedTrack[] = [
      track('a', 'local', '1'),
      track('b', 'youtube', '1'),
    ];
    const members: readonly PlaylistMembership[] = [
      member(20, 0, 'local', '1'),
    ];
    const result = computeAvailableTracks(lib, members);
    expect(result.map((t) => t.id)).toEqual(['b']);
  });

  it('preserves the library order in the result', () => {
    const lib: readonly UnifiedTrack[] = [
      track('a', 'local', '1'),
      track('b', 'youtube', '2'),
      track('c', 'spotify', '3'),
      track('d', 'local', '4'),
    ];
    const members: readonly PlaylistMembership[] = [
      member(30, 0, 'youtube', '2'),
    ];
    const result = computeAvailableTracks(lib, members);
    expect(result.map((t) => t.id)).toEqual(['a', 'c', 'd']);
  });

  it('handles a mixed-source playlist', () => {
    const lib: readonly UnifiedTrack[] = [
      track('a', 'local', '1'),
      track('b', 'youtube', '2'),
      track('c', 'spotify', '3'),
    ];
    const members: readonly PlaylistMembership[] = [
      member(40, 0, 'local', '1'),
      member(41, 1, 'spotify', '3'),
    ];
    const result = computeAvailableTracks(lib, members);
    expect(result.map((t) => t.id)).toEqual(['b']);
  });

  it('is a no-op when the library is empty', () => {
    const members: readonly PlaylistMembership[] = [
      member(50, 0, 'local', '1'),
    ];
    expect(computeAvailableTracks([], members)).toEqual([]);
  });

  it('returns a new array (does not mutate input)', () => {
    const lib: readonly UnifiedTrack[] = [
      track('a', 'local', '1'),
      track('b', 'youtube', '2'),
    ];
    const members: readonly PlaylistMembership[] = [];
    const result = computeAvailableTracks(lib, members);
    expect(result).not.toBe(lib);
    // Same shape, different reference.
    expect(result).toEqual(lib);
  });
});

// --- composeInlineMessage ------------------------------------

/**
 * The inline-message helper that surfaces under the URL pills in the
 * Add Tracks picker after a paste resolves. Pure function; the picker
 * owns timer + render, this just shapes the string.
 *
 * Five product-spec cases the prompt called out:
 *   - only-new                                  → "Added N to selection."
 *   - only-already-in-library                   → same bucket as above
 *   - mix                                       → same bucket again
 *   - only-already-in-playlist                  → "M already in this playlist."
 *   - mixed-with-already-in-playlist            → both sentences
 * collapse to two counters because "newly fetched" and "already in
 * library but not in playlist" are the same outcome from the picker's
 * point of view (both → add to selection).
 */
describe('composeInlineMessage', () => {
  it('returns null when nothing actionable happened (no-op paste)', () => {
    // Both counters zero: e.g., user pasted a URL for a track that
    // was already selected. The picker suppresses the message entirely
    // rather than showing "nothing to do."
    expect(composeInlineMessage(0, 0)).toBeNull();
  });

  it('singularizes correctly when only-added (any positive count)', () => {
    expect(composeInlineMessage(1, 0)).toBe('Added 1 to selection.');
    expect(composeInlineMessage(12, 0)).toBe('Added 12 to selection.');
  });

  it('renders only-already-in-playlist alone when nothing was added', () => {
    expect(composeInlineMessage(0, 1)).toBe('1 already in this playlist.');
    expect(composeInlineMessage(0, 3)).toBe('3 already in this playlist.');
  });

  it('renders both sentences for the mixed case', () => {
    expect(composeInlineMessage(12, 2)).toBe(
      'Added 12 to selection. 2 already in this playlist.',
    );
  });

  it('treats negative inputs defensively (callers should not pass them)', () => {
    // Negative counts would only arise from a bug in the picker's
    // reconciliation. The helper treats <=0 as "nothing to surface"
    // for that side of the message — guarding the user from a
    // "Added -1 to selection." string slipping through.
    expect(composeInlineMessage(-1, 0)).toBeNull();
    expect(composeInlineMessage(0, -2)).toBeNull();
    expect(composeInlineMessage(3, -1)).toBe('Added 3 to selection.');
  });
});
