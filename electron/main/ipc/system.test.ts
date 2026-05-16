/**
 * Tests for the openExternal URL allowlist.
 *
 * The allowlist function is exported as a pure check so we can hit
 * it without standing up `ipcMain` / `shell.openExternal`. The IPC
 * handler itself isn't unit-tested — ipcMain and shell are Electron-
 * runtime surfaces (the documented Vitest gap).
 */
import { describe, expect, it } from 'vitest';
import { isOpenExternalUrlAllowed } from './system';

describe('isOpenExternalUrlAllowed', () => {
  it('accepts https://www.youtube.com/watch?v=…', () => {
    expect(
      isOpenExternalUrlAllowed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toBe(true);
  });

  it('accepts https://youtube.com/watch?v=…  (no www)', () => {
    expect(
      isOpenExternalUrlAllowed('https://youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toBe(true);
  });

  it('accepts https://youtu.be/<id>', () => {
    expect(isOpenExternalUrlAllowed('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('rejects http (non-https) youtube URLs', () => {
    // We don't want to downgrade the user from https to http.
    expect(
      isOpenExternalUrlAllowed('http://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toBe(false);
  });

  it('rejects non-youtube hosts', () => {
    expect(isOpenExternalUrlAllowed('https://example.com/watch')).toBe(false);
    expect(isOpenExternalUrlAllowed('https://google.com')).toBe(false);
  });

  it('rejects youtube paths other than /watch and bare youtu.be host', () => {
    // Channels, search, etc. — surface paths we don't proactively
    // expose to the user. New affordance? New allowlist entry.
    expect(isOpenExternalUrlAllowed('https://www.youtube.com/')).toBe(false);
    expect(
      isOpenExternalUrlAllowed('https://www.youtube.com/results?search_query=x'),
    ).toBe(false);
    expect(isOpenExternalUrlAllowed('https://youtu.be/')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isOpenExternalUrlAllowed('not a url')).toBe(false);
    expect(isOpenExternalUrlAllowed('')).toBe(false);
  });

  it('rejects dangerous schemes outright', () => {
    expect(isOpenExternalUrlAllowed('file:///etc/passwd')).toBe(false);
    expect(
      isOpenExternalUrlAllowed('javascript:alert(1)'),
    ).toBe(false);
    expect(
      isOpenExternalUrlAllowed('musaic-file:///foo.mp3'),
    ).toBe(false);
  });

  it('rejects subdomain spoofs', () => {
    // www.youtube.com.evil.com would match a substring check but
    // not the exact-host check we do.
    expect(
      isOpenExternalUrlAllowed('https://www.youtube.com.evil.com/watch?v=x'),
    ).toBe(false);
    expect(
      isOpenExternalUrlAllowed('https://evil.com/www.youtube.com/watch?v=x'),
    ).toBe(false);
  });

  // --- Spotify allowlist ---------------------------------

  it('accepts https://open.spotify.com/track/<22b62>', () => {
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
      ),
    ).toBe(true);
  });

  it('rejects Spotify album/playlist/artist URLs', () => {
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj',
      ),
    ).toBe(false);
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      ),
    ).toBe(false);
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/artist/1Xyo4u8uXC1ZmMpatF05PJ',
      ),
    ).toBe(false);
  });

  it('rejects intl-prefixed Spotify track paths', () => {
    // The renderer always builds the canonical /track/<id> URL; we
    // reject /intl-* paths at the boundary so a future regression
    // doesn't slip a different shape through.
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/intl-en/track/0VjIjW4GlUZAMYd2vXMi3b',
      ),
    ).toBe(false);
  });

  it('rejects Spotify track URLs with bad ids', () => {
    expect(
      isOpenExternalUrlAllowed('https://open.spotify.com/track/tooshort'),
    ).toBe(false);
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3bEXTRA',
      ),
    ).toBe(false);
  });

  it('rejects Spotify URLs on wrong subdomain', () => {
    expect(
      isOpenExternalUrlAllowed(
        'https://music.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
      ),
    ).toBe(false);
  });

  it('rejects http (non-https) Spotify URLs', () => {
    expect(
      isOpenExternalUrlAllowed(
        'http://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
      ),
    ).toBe(false);
  });

  it('rejects Spotify host with extra path segments', () => {
    expect(
      isOpenExternalUrlAllowed(
        'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b/extra',
      ),
    ).toBe(false);
  });
});
