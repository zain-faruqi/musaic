import { describe, it, expect } from 'vitest';
import { pathToLocalFileUrl } from './file-url';

describe('pathToLocalFileUrl', () => {
  it('builds a musaic-file:// URL with localhost authority', () => {
    expect(pathToLocalFileUrl('/Users/zain/Music/song.mp3')).toBe(
      'musaic-file://localhost/Users/zain/Music/song.mp3',
    );
  });

  it('preserves the case of path segments (regression: standard-scheme lowercase host)', () => {
    // Without the localhost authority, Chromium normalizes
    // `musaic-file:///Users/...` → `musaic-file://users/...` — lowercase.
    // The localhost authority keeps `Users` in the path where case is preserved.
    const url = pathToLocalFileUrl('/Users/zain/Music/song.mp3');
    expect(url).toContain('/Users/');
    expect(url).not.toContain('/users/');
  });

  it('encodes spaces', () => {
    expect(pathToLocalFileUrl('/Users/zain/Music/My Song.mp3')).toBe(
      'musaic-file://localhost/Users/zain/Music/My%20Song.mp3',
    );
  });

  it('encodes URL-significant characters', () => {
    const url = pathToLocalFileUrl('/Users/zain/Music/song#1?.mp3');
    expect(url).toContain('%23');
    expect(url).toContain('%3F');
  });

  it('preserves / separators', () => {
    const url = pathToLocalFileUrl('/a/b/c.mp3');
    expect(url).toBe('musaic-file://localhost/a/b/c.mp3');
  });

  it('round-trips with URL parsing (pathname recovers the original path)', () => {
    const path = '/Users/zain/Music/Some Song & Stuff.mp3';
    const parsed = new URL(pathToLocalFileUrl(path));
    expect(parsed.host).toBe('localhost');
    expect(decodeURIComponent(parsed.pathname)).toBe(path);
  });

  it('normalizes backslashes to forward slashes', () => {
    // encodeURIComponent encodes the `:` in `C:` to `%3A`, which is correct
    // (`:` is URL-significant inside path segments). Round-tripping works fine.
    const url = pathToLocalFileUrl('C:\\Music\\song.mp3');
    expect(url).toMatch(/^musaic-file:\/\/localhost\//);
    expect(url).not.toContain('\\');
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.pathname)).toBe('/C:/Music/song.mp3');
  });
});
