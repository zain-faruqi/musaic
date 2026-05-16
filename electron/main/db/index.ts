/**
 * Database opener. Composes the migration runner with the SQL files
 * baked in via import.meta.glob.
 *
 *   - PRAGMAs: WAL journaling, NORMAL synchronous, foreign keys on.
 *   - Migrations: every numbered file in ./migrations/*.sql. Bundler
 *     inlines them via the glob; no runtime fs reads, no missing-asset
 *     class of failure.
 *
 * Call once at app start, after the user-data dir is known. Pass the
 * returned Database instance to anything that needs to query.
 */
import { DatabaseSync } from 'node:sqlite';
import { discover, migrate } from './runner';

// Vite/electron-vite glob: each .sql file becomes a string in this
// record at build time. Eager so migrations are ready synchronously.
const MIGRATION_FILES = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BUILTIN_MIGRATIONS = discover(MIGRATION_FILES);

export type OpenDbOptions = {
  /** Absolute path to the .db file. */
  readonly path: string;
};

export function openDb(opts: OpenDbOptions): DatabaseSync {
  const db = new DatabaseSync(opts.path);

  // WAL is the right journal mode for a desktop app: better
  // concurrency, atomic commits. NORMAL is the WAL-paired safety
  // level (fsync on commit, not on every write).
  //
  // node:sqlite has no `db.pragma(...)` ergonomic helper; PRAGMA is
  // just SQL run via exec().
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db, BUILTIN_MIGRATIONS);

  return db;
}
