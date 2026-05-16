/**
 * PKCE primitive tests.
 *
 * The RFC 7636 §4 worked example is the load-bearing case here — if
 * `challengeFromVerifier` doesn't produce the documented output for the
 * documented input, Spotify's token endpoint will reject the exchange
 * with `invalid_grant` and nothing else in the OAuth flow matters. The
 * other tests are shape / range / determinism checks.
 */
import { describe, expect, it } from 'vitest';
import {
  challengeFromVerifier,
  generateState,
  generateVerifier,
} from './pkce';

describe('challengeFromVerifier (RFC 7636 §4 worked example)', () => {
  it('produces the documented challenge for the documented verifier', async () => {
    // From RFC 7636 §4 — Appendix B reproduces these as the canonical
    // S256 worked example. Any drift in our base64url encoding, SHA-256
    // input encoding, or padding-strip will fail this test.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await challengeFromVerifier(verifier)).toBe(challenge);
  });

  it('is deterministic — same input, same challenge', async () => {
    const v = generateVerifier();
    const a = await challengeFromVerifier(v);
    const b = await challengeFromVerifier(v);
    expect(a).toBe(b);
  });

  it('produces a URL-safe base64 string (no +, /, or =)', async () => {
    // S256's base64url alphabet replaces +/+ with -/_ and strips
    // padding. Even one stray character of the standard alphabet
    // breaks the redirect URI parsing on Spotify's side.
    const challenge = await challengeFromVerifier(generateVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('generateVerifier', () => {
  it('returns a 64-character string from the URL-safe charset', () => {
    const v = generateVerifier();
    expect(v).toHaveLength(64);
    // RFC 7636 §4.1: unreserved = [A-Z][a-z][0-9] / "-" / "." / "_" / "~"
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('produces different values across calls', () => {
    // Not a statistical guarantee — but for a 64-char string drawn
    // from 66 characters via cryptographic RNG, two consecutive calls
    // colliding would be evidence of a real bug, not bad luck.
    const a = generateVerifier();
    const b = generateVerifier();
    expect(a).not.toBe(b);
  });

  it('respects the 43..128 length bound from RFC 7636 §4.1', () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });
});

describe('generateState', () => {
  it('returns a 32-character URL-safe string', () => {
    const s = generateState();
    expect(s).toHaveLength(32);
    expect(s).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('produces different values across calls', () => {
    expect(generateState()).not.toBe(generateState());
  });
});
