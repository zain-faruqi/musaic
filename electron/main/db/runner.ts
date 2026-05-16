/**
 * SQLite migration runner.
 *
 * Uses `PRAGMA user_version` as the applied-migration counter. SQLite
 * never touches user_version itself — it's an app-controlled scratch
 * slot exactly suited for this. Fresh DB returns 0; after running
 * 0001_initial.sql we set it to 1; etc.
 *
 * The two exported functions are deliberately pure with respect to
 * their inputs:
 *
 *   discover(files)   — sort, validate naming, detect duplicates and
 *                       gaps. Takes the raw glob result; no fs touch.
 *   migrate(db, ms)   — applies pending migrations, each in its own
 *                       transaction. Idempotent: re-running is a no-op.
 *
 * Production composes them in db/index.ts using `import.meta.glob` to
 * load the SQL files as raw strings; tests compose them with fixture
 * Records. Both halves are unit-testable in isolation.
 */
import type { DatabaseSync } from 'node:sqlite';

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

const FILENAME_RE = /(\d{4})_([a-z0-9_]+)\.sql$/i;

/**
 * Parse a glob result (`{ filename: rawSql }`) into a sorted, validated
 * list of migrations.
 *
 * Throws on:
 *   - filename not matching `NNNN_name.sql`
 *   - duplicate version numbers
 *   - non-contiguous version sequence (gaps before any present version)
 *
 * Loud failure here is on purpose: a missing migration file is almost
 * always a bad merge or partial pull, not an intentional skip.
 */
export function discover(files: Record<string, string>): readonly Migration[] {
  const seen = new Set<number>();
  const list: Migration[] = [];

  for (const [filePath, sql] of Object.entries(files)) {
    const match = FILENAME_RE.exec(filePath);
    if (!match) {
      throw new Error(`migration filename invalid: ${filePath}`);
    }
    const versionStr = match[1];
    const name = match[2];
    if (versionStr === undefined || name === undefined) {
      throw new Error(`migration filename invalid: ${filePath}`);
    }
    const version = Number.parseInt(versionStr, 10);
    if (seen.has(version)) {
      throw new Error(`duplicate migration version ${version}: ${filePath}`);
    }
    seen.add(version);
    list.push({ version, name, sql });
  }

  list.sort((a, b) => a.version - b.version);

  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `migration gap: expected version ${i + 1} but found ${m.version} (${m.name})`,
      );
    }
  });

  return list;
}

/**
 * Apply any migrations whose version is greater than the DB's current
 * `user_version`. Each migration runs in its own transaction; if the
 * SQL throws, the transaction rolls back and `user_version` stays put.
 *
 * Safe to call on every app start. If everything is already applied,
 * this is a one-pragma-read no-op.
 *
 * node:sqlite has no `db.transaction(fn)` wrapper (that's a
 * better-sqlite3 ergonomic); we use raw BEGIN/COMMIT/ROLLBACK via
 * exec(). The semantics are the same — partial failure rolls back,
 * user_version stays put.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[],
): void {
  const currentRow = db
    .prepare('PRAGMA user_version')
    .get() as { user_version: number };
  const current = currentRow.user_version;

  for (const m of migrations) {
    if (m.version <= current) continue;

    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      // Setting user_version is intentionally inside the transaction
      // so a rare pragma-write failure rolls back the SQL.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      // SQLite normally requires an explicit ROLLBACK after a failed
      // statement inside a transaction. A few error classes auto-roll-
      // back (and a subsequent ROLLBACK throws "no transaction is
      // active"); the migration tests cover the explicit case, but
      // guard against the implicit one so failure surfaces the
      // original error rather than the rollback-on-already-rolled-
      // back follow-on.
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite; nothing to do.
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `migration ${m.version} (${m.name}) failed: ${message}`,
      );
    }
  }
}
