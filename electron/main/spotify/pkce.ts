/**
 * PKCE primitives for Spotify's Authorization Code + PKCE flow.
 *
 * Lives in main. The verifier is sensitive ephemeral state —
 * between generation and the token exchange it's effectively a
 * one-time secret. Main runs OAuth end-to-end so the verifier never
 * crosses the process boundary.
 *
 *   2. Uses `node:crypto` instead of WebCrypto / `btoa`. Same primitives,
 *      same RFC 7636 §4 shape, but native to the runtime. No SubtleCrypto
 *      Promise wrapping; the SHA-256 call is sync.
 *
 * Reference: RFC 7636 (Proof Key for Code Exchange) §4.
 *   - code_verifier: 43..128 chars from `[A-Z][a-z][0-9]-._~`.
 *   - code_challenge = base64url(SHA-256(code_verifier))   (S256 method).
 */
import { createHash, randomBytes } from 'node:crypto';

// 64 is comfortably inside the 43..128 range.
const VERIFIER_LENGTH = 64;

// RFC 7636 §4.1 allows the URL-safe alphabet plus `-._~`. We use it
// verbatim. 66 characters total — close enough to a power of two that
// modulo bias on the random byte mapping is negligible at this length.
const VERIFIER_CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * Generate a cryptographically random verifier from the URL-safe
 * alphabet. Output length is fixed at VERIFIER_LENGTH.
 */
export function generateVerifier(): string {
  const bytes = randomBytes(VERIFIER_LENGTH);
  let out = '';
  for (let i = 0; i < VERIFIER_LENGTH; i++) {
    // bytes[i] is `number | undefined` only because of noUncheckedIndexedAccess;
    // we know the index is in range because we sized the buffer ourselves.
    const byte = bytes[i] ?? 0;
    out += VERIFIER_CHARSET.charAt(byte % VERIFIER_CHARSET.length);
  }
  return out;
}

/**
 * Base64url-encode a Buffer (no padding, `-` / `_` alphabet). Per
 * RFC 7636's S256 method and RFC 4648 §5.
 */
function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Derive the code_challenge from a code_verifier per RFC 7636 §4.2:
 *
 *   code_challenge = base64url(SHA-256(ASCII(code_verifier)))
 *
 * Returns a Promise to keep the signature uniform with the previous
 * WebCrypto-based version. The underlying work is sync; the wrapper
 * is just `Promise.resolve(...)`.
 */
export function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = createHash('sha256').update(verifier, 'ascii').digest();
  return Promise.resolve(base64url(digest));
}

/**
 * Random URL-safe state value for CSRF protection in the OAuth flow.
 * Same alphabet as the verifier; 32 chars is plenty for collision
 * resistance and stays well within Spotify's accepted length.
 */
export function generateState(): string {
  const bytes = randomBytes(32);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    out += VERIFIER_CHARSET.charAt(byte % VERIFIER_CHARSET.length);
  }
  return out;
}
