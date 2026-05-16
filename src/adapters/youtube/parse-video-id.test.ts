import { describe, it, expect } from 'vitest';
import { parseYouTubeVideoId } from './parse-video-id';

// A handful of known-shape IDs to use across cases. Length is the
// invariant: YouTube IDs are exactly 11 chars from [A-Za-z0-9_-].
const ID_A = 'dQw4w9WgXcQ';
const ID_B = 'aBc-Def_123';

describe('parseYouTubeVideoId — bare IDs', () => {
  it('returns a valid bare ID unchanged', () => {
    expect(parseYouTubeVideoId(ID_A)).toBe(ID_A);
  });

  it('trims whitespace around a bare ID', () => {
    expect(parseYouTubeVideoId(`  ${ID_A}  `)).toBe(ID_A);
  });

  it('accepts underscores and hyphens', () => {
    expect(parseYouTubeVideoId(ID_B)).toBe(ID_B);
  });

  it('rejects an ID-shaped string of the wrong length', () => {
    expect(parseYouTubeVideoId('shortid')).toBeNull();
    expect(parseYouTubeVideoId('thisidiswaytoolong')).toBeNull();
  });
});

describe('parseYouTubeVideoId — watch URLs', () => {
  it('extracts from youtube.com/watch?v=<id>', () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID_A}`)).toBe(ID_A);
  });

  it('extracts when extra query params are present', () => {
    expect(
      parseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID_A}&t=42s&feature=share`),
    ).toBe(ID_A);
  });

  it('accepts m.youtube.com', () => {
    expect(parseYouTubeVideoId(`https://m.youtube.com/watch?v=${ID_A}`)).toBe(ID_A);
  });

  it('accepts bare youtube.com (no www / m)', () => {
    expect(parseYouTubeVideoId(`https://youtube.com/watch?v=${ID_A}`)).toBe(ID_A);
  });

  it('returns null when v param is missing', () => {
    expect(parseYouTubeVideoId('https://www.youtube.com/watch')).toBeNull();
  });

  it('returns null when v param is malformed', () => {
    expect(parseYouTubeVideoId('https://www.youtube.com/watch?v=tooshort')).toBeNull();
  });
});

describe('parseYouTubeVideoId — short URLs', () => {
  it('extracts from youtu.be/<id>', () => {
    expect(parseYouTubeVideoId(`https://youtu.be/${ID_A}`)).toBe(ID_A);
  });

  it('extracts when youtu.be URL has a timestamp query', () => {
    expect(parseYouTubeVideoId(`https://youtu.be/${ID_A}?t=120`)).toBe(ID_A);
  });

  it('rejects youtu.be with a bare slash and no ID', () => {
    expect(parseYouTubeVideoId('https://youtu.be/')).toBeNull();
  });
});

describe('parseYouTubeVideoId — shorts / embed / v URLs', () => {
  it('extracts from /shorts/<id>', () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${ID_A}`)).toBe(ID_A);
  });

  it('extracts from /embed/<id>', () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/embed/${ID_A}`)).toBe(ID_A);
  });

  it('extracts from /v/<id>', () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/v/${ID_A}`)).toBe(ID_A);
  });

  it('accepts youtube-nocookie.com/embed/<id>', () => {
    expect(parseYouTubeVideoId(`https://www.youtube-nocookie.com/embed/${ID_A}`)).toBe(ID_A);
  });
});

describe('parseYouTubeVideoId — rejection cases', () => {
  it('rejects empty input', () => {
    expect(parseYouTubeVideoId('')).toBeNull();
  });

  it('rejects malformed URL strings that are not bare IDs', () => {
    expect(parseYouTubeVideoId('not a url at all')).toBeNull();
    expect(parseYouTubeVideoId('https://')).toBeNull();
  });

  it('rejects non-YouTube hosts', () => {
    expect(parseYouTubeVideoId(`https://vimeo.com/${ID_A}`)).toBeNull();
    expect(
      parseYouTubeVideoId(`https://example.com/watch?v=${ID_A}`),
    ).toBeNull();
  });

  it('rejects youtube.com playlist or channel URLs without a video', () => {
    expect(parseYouTubeVideoId('https://www.youtube.com/')).toBeNull();
    expect(
      parseYouTubeVideoId('https://www.youtube.com/playlist?list=PLfoo'),
    ).toBeNull();
    expect(
      parseYouTubeVideoId('https://www.youtube.com/@somechannel'),
    ).toBeNull();
  });
});
