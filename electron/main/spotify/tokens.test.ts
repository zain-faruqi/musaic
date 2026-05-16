/**
 * Token storage tests.
 *
 * The Electron `safeStorage` API and `app.getPath('userData')` only exist
 * inside the Electron runtime. We run Vitest under Electron-as-Node,
 * so the `electron` module IS resolvable — but the API
 * surfaces it exposes for our purposes (Keychain access, paths) are not
 * functional without the full Electron app environment.
 *
 * vi.mock() solves both: stub `safeStorage` so encrypt/decrypt is just a
 * round-trip we can introspect; stub `app.getPath` so writes go to a
 * temp directory the test fully owns.
 *
 * The tests focus on what we control: the file lifecycle (write, read,
 * clear), the round-trip happy path, and the "treat-as-disconnected"
 * branches (missing, corrupt, schema-mismatch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ----- Electron module stub -------------------------------------------
//
// Reverses encryptString in decryptString so we can write a value
// through saveTokens and read it back through loadTokens. The wire
// format is a Buffer; we wrap the UTF-8 plaintext in a tagged prefix so
// the tests can also drive "corrupt ciphertext" cases by writing raw
// bytes that DON'T have the prefix.

const ENC_PREFIX = 'enc:';

let userDataDir = '';
let encryptionAvailable = true;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return userDataDir;
      throw new Error(`mock app.getPath: unsupported path ${name}`);
    },
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => encryptionAvailable,
    encryptString: (s: string): Buffer => Buffer.from(`${ENC_PREFIX}${s}`, 'utf-8'),
    decryptString: (buf: Buffer): string => {
      const text = buf.toString('utf-8');
      if (!text.startsWith(ENC_PREFIX)) {
        throw new Error('mock safeStorage: ciphertext lacks prefix');
      }
      return text.slice(ENC_PREFIX.length);
    },
  },
}));

// Imports MUST come after vi.mock declarations.
import { loadTokens, saveTokens, clearTokens, type StoredTokens } from './tokens';

const sample: StoredTokens = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-xyz',
  expiresAt: 1_700_000_000_000,
  scope: 'streaming user-read-email',
};

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'musaic-tokens-test-'));
  encryptionAvailable = true;
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('saveTokens / loadTokens', () => {
  it('round-trips a token set through encryption', async () => {
    await saveTokens(sample);
    const loaded = await loadTokens();
    expect(loaded).toEqual(sample);
  });

  it('overwrites an existing file on subsequent saves', async () => {
    await saveTokens(sample);
    const next: StoredTokens = { ...sample, accessToken: 'access-new' };
    await saveTokens(next);
    const loaded = await loadTokens();
    expect(loaded?.accessToken).toBe('access-new');
  });

  it('persists at <userData>/spotify-tokens.enc', async () => {
    await saveTokens(sample);
    const stat = await fs.stat(join(userDataDir, 'spotify-tokens.enc'));
    expect(stat.isFile()).toBe(true);
  });

  it('uses an atomic write — no leftover tmp file', async () => {
    await saveTokens(sample);
    const entries = await fs.readdir(userDataDir);
    expect(entries).toContain('spotify-tokens.enc');
    expect(entries).not.toContain('spotify-tokens.enc.tmp');
  });
});

describe('loadTokens (failure modes — treat as not connected)', () => {
  it('returns null when the file does not exist', async () => {
    expect(await loadTokens()).toBeNull();
  });

  it('returns null when the ciphertext fails to decrypt', async () => {
    // Write bytes that the mock safeStorage will reject (missing prefix).
    await fs.writeFile(
      join(userDataDir, 'spotify-tokens.enc'),
      Buffer.from('not-encrypted-bytes', 'utf-8'),
    );
    expect(await loadTokens()).toBeNull();
  });

  it('returns null when the decrypted payload is not valid JSON', async () => {
    // Decrypt succeeds but JSON.parse fails.
    await fs.writeFile(
      join(userDataDir, 'spotify-tokens.enc'),
      Buffer.from(`${ENC_PREFIX}{not valid json`, 'utf-8'),
    );
    expect(await loadTokens()).toBeNull();
  });

  it('returns null when the decrypted JSON does not match the schema', async () => {
    // Missing required fields (refreshToken, expiresAt).
    await fs.writeFile(
      join(userDataDir, 'spotify-tokens.enc'),
      Buffer.from(
        `${ENC_PREFIX}${JSON.stringify({ accessToken: 'a', scope: 's' })}`,
        'utf-8',
      ),
    );
    expect(await loadTokens()).toBeNull();
  });

  it('returns null when safeStorage encryption is unavailable', async () => {
    // Write a real-looking file, then flip the encryption-available
    // flag — simulates a Keychain that's gone unavailable since the
    // file was originally written.
    await saveTokens(sample);
    encryptionAvailable = false;
    expect(await loadTokens()).toBeNull();
  });
});

describe('saveTokens (error paths)', () => {
  it('throws when safeStorage encryption is unavailable', async () => {
    encryptionAvailable = false;
    await expect(saveTokens(sample)).rejects.toThrow(/safeStorage encryption/);
  });

  it('rejects on programmer-error inputs that violate the schema', async () => {
    // `expiresAt` is required to be a finite non-negative number; pass
    // a string and confirm we reject before writing.
    const bad = { ...sample, expiresAt: 'not-a-number' as unknown as number };
    await expect(saveTokens(bad)).rejects.toThrow();
    // And no file should have been written.
    const entries = await fs.readdir(userDataDir);
    expect(entries).not.toContain('spotify-tokens.enc');
  });
});

describe('clearTokens', () => {
  it('removes the tokens file', async () => {
    await saveTokens(sample);
    await clearTokens();
    expect(await loadTokens()).toBeNull();
  });

  it('is idempotent — no-op on missing file', async () => {
    // No prior save; clear should NOT throw.
    await expect(clearTokens()).resolves.toBeUndefined();
  });

  it('makes a subsequent loadTokens return null', async () => {
    await saveTokens(sample);
    await clearTokens();
    expect(await loadTokens()).toBeNull();
  });
});
