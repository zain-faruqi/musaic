/**
 * Spotify token storage backed by Electron's `safeStorage`.
 *
 * Why safeStorage and not keytar: safeStorage is built into Electron
 * and uses the OS Keychain on macOS through the
 * OS-supplied API. No native module, no prebuild-install dance, no risk
 * of an ABI break against a future Electron major. For a single-row
 * token store (refresh + access + expiry + scopes) a flat encrypted
 * file is enough; SQLite would be overkill.
 *
 * Storage shape: one JSON document, encrypted by safeStorage, written
 * atomically to `<userData>/spotify-tokens.enc`. Atomic write (tmp +
 * rename) prevents a half-written file from being misread as corrupt
 * on the next launch.
 *
 * Failure modes:
 *   - `safeStorage.isEncryptionAvailable()` returns false → throw on
 *     first write. The user can't have hit this on a working macOS
 *     install, but defensive logging matters when it does.
 *   - File missing → loadTokens returns null (not connected).
 *   - File present but doesn't decrypt or doesn't parse → loadTokens
 *     returns null. Corruption (or a Keychain key rotation) is the
 *     same UX as "not connected": the user clicks Connect again.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { z } from 'zod';

const STORE_FILENAME = 'spotify-tokens.enc';

/**
 * The token shape persisted to disk. Mirrored as a Zod schema so the
 * round-trip is validated; a corrupted or partially-migrated file
 * round-trips as `null` rather than crashing.
 *
 * `expiresAt` is ms-since-epoch (Spotify hands us `expires_in` seconds;
 * the conversion to an absolute deadline happens at exchange time so the
 * decision "is this token about to expire?" doesn't need a wall-clock
 * comparison with a relative duration).
 *
 * `scope` is the space-delimited string Spotify returns — we don't split
 * it. The exact bytes are what we'd send back on re-auth if we ever did
 * scope-narrowing diff logic.
 */
const storedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite().nonnegative(),
  scope: z.string(),
});

export type StoredTokens = z.infer<typeof storedTokensSchema>;

/**
 * Resolve the on-disk path. `app.getPath('userData')` resolves
 * differently in dev vs packaged
 * but the same code path applies in both. Function-scoped so tests can
 * mock `app.getPath` via the module if they need to.
 */
function tokensFilePath(): string {
  return join(app.getPath('userData'), STORE_FILENAME);
}

/**
 * Guard around `safeStorage.isEncryptionAvailable()`. Thrown errors
 * carry enough context for the user to act on — on macOS this almost
 * always means the user is running a corrupted Keychain or a Keychain-
 * locked profile; both are recoverable but neither is something we can
 * fix from here.
 */
function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'spotify tokens: safeStorage encryption is not available on this system. ' +
        'On macOS this usually means the Keychain is locked or unavailable; ' +
        'unlock Keychain Access and retry.',
    );
  }
}

/**
 * Load and decrypt the on-disk tokens. Returns `null` for any of:
 *   - file missing
 *   - decrypt fails
 *   - JSON.parse fails
 *   - Zod schema mismatch
 *
 * All four cases mean "the renderer should see disconnected" and there's
 * nothing the caller can act on to distinguish them. Errors are logged
 * (so a developer can diagnose) but not surfaced as rejections.
 */
export async function loadTokens(): Promise<StoredTokens | null> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(tokensFilePath());
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'ENOENT') return null;
    // Read error other than missing-file (permissions, etc.). Log and
    // treat as not-connected — the user can re-connect; we won't silently
    // succeed pretending the read worked.
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('spotify tokens: read failed:', msg);
    return null;
  }

  // Decrypt requires safeStorage to be available. If it isn't, the
  // ciphertext is useless and we can't recover anything from it.
  if (!safeStorage.isEncryptionAvailable()) {
    console.error(
      'spotify tokens: safeStorage unavailable; existing encrypted file unreadable. ' +
        'User will see disconnected state until Keychain is unlocked.',
    );
    return null;
  }

  let plaintext: string;
  try {
    plaintext = safeStorage.decryptString(raw);
  } catch (err) {
    // Decrypt failure means the file was encrypted under a key we no
    // longer have (Keychain reset, profile migrated, etc.) or the file
    // is corrupt. Same UX as "not connected."
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('spotify tokens: decrypt failed:', msg);
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('spotify tokens: JSON.parse failed:', msg);
    return null;
  }

  const result = storedTokensSchema.safeParse(parsedJson);
  if (!result.success) {
    console.error(
      'spotify tokens: schema mismatch — treating as not connected.',
      result.error.format(),
    );
    return null;
  }
  return result.data;
}

/**
 * Encrypt and write tokens to disk. Atomic via tmp + rename so a
 * partially-written file can never be observed by a concurrent read.
 *
 * `safeStorage.encryptString` is sync. The fs writes are async. Order
 * matters: write tmp first, fsync isn't necessary for our purposes (we
 * accept losing the most recent token on power loss — the user
 * re-authenticates), then rename atomically.
 */
export async function saveTokens(tokens: StoredTokens): Promise<void> {
  assertEncryptionAvailable();

  // Validate the inbound shape so a programmer error (passing the wrong
  // field name, e.g.) doesn't write garbage that we'd then read back as
  // "schema mismatch / disconnected."
  storedTokensSchema.parse(tokens);

  const filePath = tokensFilePath();
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(tokens);
  const ciphertext = safeStorage.encryptString(json);

  await fs.writeFile(tmpPath, ciphertext);
  // rename is atomic on POSIX (and same-filesystem on macOS, which is
  // always the case here since both paths are under userData).
  await fs.rename(tmpPath, filePath);
}

/**
 * Remove the tokens file. Treated as idempotent: calling clear on a
 * disconnected app is a no-op, not an error.
 */
export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(tokensFilePath());
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'ENOENT') return;
    throw err;
  }
}

// Exported for tests that want to drive the schema directly.
export { storedTokensSchema };
