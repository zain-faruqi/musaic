/**
 * Parser tests for the IPC contracts.
 *
 * The eight `playlist:*` schemas are the bulk of the coverage.
 * The other channels' schemas have grown a `satisfies` relationship
 * to their
 * channels.ts types over the last several slices but were never
 * directly parsed in tests; we add a couple of positive checks for
 * those too, since the cost is low and it gives us one place to put
 * future contract assertions.
 *
 * Scope: positive parses, validation rejections, and source-enum
 * rejections. We do not assert exhaustive negative coverage for
 * every field — these are boundary-layer schemas, not the only
 * defense (the IPC handler boundary-parses, and the db helpers
 * have their own validation on top of that).
 */
import { describe, expect, it } from 'vitest';
import {
  libraryListOutput,
  libraryImportOutput,
  playlistAddTracksInput,
  playlistAddTracksOutput,
  playlistCreateInput,
  playlistCreateOutput,
  playlistDeleteInput,
  playlistGetInput,
  playlistGetOutput,
  playlistListOutput,
  playlistRemoveTracksInput,
  playlistRemoveTracksOutput,
  playlistRenameInput,
  playlistRenameOutput,
  playlistReorderInput,
  sourceSchema,
  spotifySaveOutput,
  trackRefSchema,
  youtubeSaveOutput,
} from './contracts';

describe('sourceSchema', () => {
  it('accepts the three v1 sources', () => {
    expect(sourceSchema.parse('local')).toBe('local');
    expect(sourceSchema.parse('youtube')).toBe('youtube');
    expect(sourceSchema.parse('spotify')).toBe('spotify');
  });

  it('rejects unknown source strings', () => {
    expect(() => sourceSchema.parse('apple')).toThrow();
    expect(() => sourceSchema.parse('')).toThrow();
  });
});

describe('libraryImportOutput', () => {
  it('parses a track', () => {
    const parsed = libraryImportOutput.parse({
      id: 'local:/x.mp3',
      source: 'local',
      sourceId: '/x.mp3',
      title: 't',
      artists: ['a'],
      durationMs: 0,
    });
    expect(parsed).not.toBeNull();
  });

  it('parses null (user cancelled)', () => {
    expect(libraryImportOutput.parse(null)).toBeNull();
  });
});

describe('libraryListOutput', () => {
  it('parses an empty array', () => {
    expect(libraryListOutput.parse([])).toEqual([]);
  });

  it('parses an array of tracks across sources', () => {
    const out = libraryListOutput.parse([
      {
        id: 'local:/a.mp3',
        source: 'local',
        sourceId: '/a.mp3',
        title: 'A',
        artists: [],
        durationMs: 0,
      },
      {
        id: 'youtube:abc',
        source: 'youtube',
        sourceId: 'abc',
        title: 'B',
        artists: ['x'],
        durationMs: 100,
      },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('playlistCreateInput', () => {
  it('parses a simple name', () => {
    expect(playlistCreateInput.parse({ name: 'foo' })).toEqual({ name: 'foo' });
  });

  it('rejects a non-string name', () => {
    expect(() => playlistCreateInput.parse({ name: 123 })).toThrow();
  });

  it('rejects a missing name', () => {
    expect(() => playlistCreateInput.parse({})).toThrow();
  });

  it('rejects an absurdly long name (above the 4096-char input cap)', () => {
    // The boundary cap on the input schema is 4096; the db's
    // validateName trims and applies the 256-char limit. The
    // input cap catches "shoveled in a 1MB string" attacks at the
    // boundary, before we touch the db.
    expect(() =>
      playlistCreateInput.parse({ name: 'a'.repeat(4097) }),
    ).toThrow();
  });

  it('accepts an empty-string name (db layer rejects, not the contract)', () => {
    // The empty case is meaningful at the discriminated-output
    // layer ('invalid-name', reason: 'empty'). If the contract
    // rejected empty here we'd have to plumb a separate error
    // path. Empty is a valid input shape; the db semantics reject.
    expect(playlistCreateInput.parse({ name: '' })).toEqual({ name: '' });
  });
});

describe('playlistCreateOutput', () => {
  it('parses the created variant', () => {
    const out = playlistCreateOutput.parse({
      kind: 'created',
      playlist: { id: 1, name: 'x', createdAt: 1, updatedAt: 1 },
    });
    expect(out.kind).toBe('created');
  });

  it('parses the invalid-name variant', () => {
    const out = playlistCreateOutput.parse({
      kind: 'invalid-name',
      reason: 'empty',
    });
    expect(out.kind).toBe('invalid-name');
  });

  it('rejects an unknown discriminant kind', () => {
    expect(() =>
      playlistCreateOutput.parse({ kind: 'wat', playlist: {} }),
    ).toThrow();
  });

  it('rejects an invalid reason', () => {
    expect(() =>
      playlistCreateOutput.parse({
        kind: 'invalid-name',
        reason: 'not-a-reason',
      }),
    ).toThrow();
  });
});

describe('playlistRenameInput / playlistRenameOutput', () => {
  it('rename input parses with id + name', () => {
    expect(playlistRenameInput.parse({ id: 1, name: 'x' })).toEqual({
      id: 1,
      name: 'x',
    });
  });

  it('rename input rejects negative id', () => {
    expect(() => playlistRenameInput.parse({ id: -1, name: 'x' })).toThrow();
  });

  it('rename output discriminates on kind', () => {
    expect(
      playlistRenameOutput.parse({
        kind: 'renamed',
        playlist: { id: 1, name: 'x', createdAt: 0, updatedAt: 1 },
      }).kind,
    ).toBe('renamed');
    expect(
      playlistRenameOutput.parse({ kind: 'invalid-name', reason: 'too-long' })
        .kind,
    ).toBe('invalid-name');
  });
});

describe('playlistDeleteInput / playlistGetInput', () => {
  it('delete input parses an id', () => {
    expect(playlistDeleteInput.parse({ id: 1 })).toEqual({ id: 1 });
  });
  it('get input parses an id', () => {
    expect(playlistGetInput.parse({ id: 1 })).toEqual({ id: 1 });
  });
  it('reject non-int ids', () => {
    expect(() => playlistDeleteInput.parse({ id: 1.5 })).toThrow();
    expect(() => playlistGetInput.parse({ id: 'one' })).toThrow();
  });
});

describe('playlistListOutput / playlistGetOutput', () => {
  it('list parses an empty array', () => {
    expect(playlistListOutput.parse([])).toEqual([]);
  });

  it('list parses summaries with trackCount', () => {
    const out = playlistListOutput.parse([
      { id: 1, name: 'a', createdAt: 1, updatedAt: 2, trackCount: 3 },
    ]);
    expect(out[0]?.trackCount).toBe(3);
  });

  it('get output parses null', () => {
    expect(playlistGetOutput.parse(null)).toBeNull();
  });

  it('get output parses a detail with ordered tracks', () => {
    const out = playlistGetOutput.parse({
      id: 1,
      name: 'p',
      createdAt: 1,
      updatedAt: 2,
      tracks: [
        {
          playlistTrackId: 10,
          position: 0,
          track: {
            id: 'local:/a.mp3',
            source: 'local',
            sourceId: '/a.mp3',
            title: 'A',
            artists: [],
            durationMs: 0,
          },
        },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.tracks[0]?.track.source).toBe('local');
  });

  it('get output rejects a track row with an unknown source', () => {
    expect(() =>
      playlistGetOutput.parse({
        id: 1,
        name: 'p',
        createdAt: 1,
        updatedAt: 2,
        tracks: [
          {
            playlistTrackId: 10,
            position: 0,
            track: {
              id: 'apple:/a.mp3',
              source: 'apple',
              sourceId: '/a.mp3',
              title: 'A',
              artists: [],
              durationMs: 0,
            },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('playlistAddTracksInput / Output', () => {
  it('input parses with a valid track ref', () => {
    expect(
      playlistAddTracksInput.parse({
        id: 1,
        tracks: [{ source: 'local', sourceId: '/a.mp3' }],
      }),
    ).toBeDefined();
  });

  it('input rejects a track ref with an unknown source', () => {
    expect(() =>
      playlistAddTracksInput.parse({
        id: 1,
        tracks: [{ source: 'apple', sourceId: '/a.mp3' }],
      }),
    ).toThrow();
  });

  it('input accepts an empty tracks array', () => {
    expect(
      playlistAddTracksInput.parse({ id: 1, tracks: [] }),
    ).toBeDefined();
  });

  it('output parses an { added, skipped } pair', () => {
    expect(
      playlistAddTracksOutput.parse({ added: 2, skipped: 1 }),
    ).toEqual({ added: 2, skipped: 1 });
  });

  it('output rejects a negative count', () => {
    expect(() =>
      playlistAddTracksOutput.parse({ added: -1, skipped: 0 }),
    ).toThrow();
  });
});

describe('playlistRemoveTracksInput / Output', () => {
  it('input parses', () => {
    expect(
      playlistRemoveTracksInput.parse({
        id: 1,
        playlistTrackIds: [10, 11],
      }),
    ).toBeDefined();
  });
  it('input accepts an empty list', () => {
    expect(
      playlistRemoveTracksInput.parse({ id: 1, playlistTrackIds: [] }),
    ).toBeDefined();
  });
  it('input rejects negative ids', () => {
    expect(() =>
      playlistRemoveTracksInput.parse({
        id: 1,
        playlistTrackIds: [-1],
      }),
    ).toThrow();
  });
  it('output parses { removed }', () => {
    expect(playlistRemoveTracksOutput.parse({ removed: 0 })).toEqual({
      removed: 0,
    });
  });
});

describe('playlistReorderInput', () => {
  it('parses a list of ids', () => {
    expect(
      playlistReorderInput.parse({
        id: 1,
        orderedPlaylistTrackIds: [3, 2, 1],
      }),
    ).toBeDefined();
  });
  it('rejects a non-array orderedPlaylistTrackIds', () => {
    expect(() =>
      playlistReorderInput.parse({
        id: 1,
        orderedPlaylistTrackIds: 'oops',
      }),
    ).toThrow();
  });
  it('rejects negative ids', () => {
    expect(() =>
      playlistReorderInput.parse({
        id: 1,
        orderedPlaylistTrackIds: [1, -1, 2],
      }),
    ).toThrow();
  });
});

// --- trackRefSchema + refs on save outputs --------------------

/**
 * `trackRefSchema` is a shared exported atom rather than file-local
 * inside `playlistAddTracksInput`. The paste-and-save /
 * paste-and-import responses also carry arrays of
 * refs (the picker's auto-select path reads them). The schema gets
 * `satisfies` against the channels.ts `TrackRef` type so drift is a
 * compile-time error; positive parse coverage lives here.
 */
describe('trackRefSchema', () => {
  it('parses a valid ref', () => {
    expect(
      trackRefSchema.parse({ source: 'spotify', sourceId: 'spotify:track:xyz' }),
    ).toEqual({ source: 'spotify', sourceId: 'spotify:track:xyz' });
  });

  it('rejects unknown sources', () => {
    expect(() =>
      trackRefSchema.parse({ source: 'apple', sourceId: 'whatever' }),
    ).toThrow();
  });

  it('rejects a missing sourceId', () => {
    expect(() => trackRefSchema.parse({ source: 'youtube' })).toThrow();
  });
});

describe('youtubeSaveOutput — refs', () => {
  const SAVED_TRACK = {
    id: 'youtube:dQw4w9WgXcQ',
    source: 'youtube' as const,
    sourceId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artists: ['Rick Astley'],
    durationMs: 0,
  };

  it("parses 'saved' variant with refs array", () => {
    const out = youtubeSaveOutput.parse({
      kind: 'saved',
      track: SAVED_TRACK,
      refs: [{ source: 'youtube', sourceId: 'dQw4w9WgXcQ' }],
    });
    expect(out.kind).toBe('saved');
  });

  it("rejects 'saved' without refs (5b made the field required)", () => {
    expect(() =>
      youtubeSaveOutput.parse({
        kind: 'saved',
        track: SAVED_TRACK,
      }),
    ).toThrow();
  });

  it("parses 'embed-restricted' without refs (deliberately omitted in 5b)", () => {
    const out = youtubeSaveOutput.parse({
      kind: 'embed-restricted',
      track: SAVED_TRACK,
    });
    expect(out.kind).toBe('embed-restricted');
  });
});

describe('spotifySaveOutput — refs', () => {
  const SAVED_TRACK = {
    id: 'spotify:spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
    source: 'spotify' as const,
    sourceId: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
    title: 'Blinding Lights',
    artists: ['The Weeknd'],
    durationMs: 200040,
  };

  it("parses 'saved' variant with refs", () => {
    const out = spotifySaveOutput.parse({
      kind: 'saved',
      track: SAVED_TRACK,
      refs: [
        { source: 'spotify', sourceId: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b' },
      ],
    });
    expect(out.kind).toBe('saved');
  });

  it("rejects 'saved' without refs", () => {
    expect(() =>
      spotifySaveOutput.parse({ kind: 'saved', track: SAVED_TRACK }),
    ).toThrow();
  });

  it("parses 'imported' variant with refs (including empty array for all-skipped imports)", () => {
    const out = spotifySaveOutput.parse({
      kind: 'imported',
      imported: 0,
      skipped: 5,
      truncated: false,
      refs: [],
    });
    expect(out.kind).toBe('imported');
  });

  it("rejects 'imported' without refs", () => {
    expect(() =>
      spotifySaveOutput.parse({
        kind: 'imported',
        imported: 1,
        skipped: 0,
        truncated: false,
      }),
    ).toThrow();
  });

  it("parses 'imported' with a multi-element refs array", () => {
    const out = spotifySaveOutput.parse({
      kind: 'imported',
      imported: 2,
      skipped: 0,
      truncated: false,
      refs: [
        { source: 'spotify', sourceId: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' },
        { source: 'spotify', sourceId: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb' },
      ],
    });
    expect(out.kind).toBe('imported');
    if (out.kind !== 'imported') throw new Error('unreachable');
    expect(out.refs).toHaveLength(2);
  });

  it("parses the payload-free variants unchanged ('auth-required', 'not-found' etc.)", () => {
    expect(spotifySaveOutput.parse({ kind: 'auth-required' }).kind).toBe(
      'auth-required',
    );
    expect(spotifySaveOutput.parse({ kind: 'not-found' }).kind).toBe(
      'not-found',
    );
  });
});
