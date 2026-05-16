import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover, migrate, type Migration } from './runner';

describe('discover', () => {
  it('parses a single well-formed file', () => {
    const out = discover({
      './migrations/0001_initial.sql': 'CREATE TABLE t(x);',
    });
    expect(out).toEqual([
      { version: 1, name: 'initial', sql: 'CREATE TABLE t(x);' },
    ]);
  });

  it('sorts numerically by version, not lexicographically', () => {
    const out = discover({
      './migrations/0010_tenth.sql': 'select 10;',
      './migrations/0002_second.sql': 'select 2;',
      './migrations/0001_first.sql': 'select 1;',
      './migrations/0009_ninth.sql': 'select 9;',
      './migrations/0003_third.sql': 'select 3;',
      './migrations/0004_fourth.sql': 'select 4;',
      './migrations/0005_fifth.sql': 'select 5;',
      './migrations/0006_sixth.sql': 'select 6;',
      './migrations/0007_seventh.sql': 'select 7;',
      './migrations/0008_eighth.sql': 'select 8;',
    });
    expect(out.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('throws on filename without the NNNN_ prefix', () => {
    expect(() =>
      discover({ './migrations/initial.sql': 'select 1;' }),
    ).toThrow(/filename invalid/);
  });

  it('throws on three-digit prefix (must be 4)', () => {
    expect(() =>
      discover({ './migrations/001_initial.sql': 'select 1;' }),
    ).toThrow(/filename invalid/);
  });

  it('throws on duplicate version numbers', () => {
    expect(() =>
      discover({
        './migrations/0001_a.sql': 'select 1;',
        './migrations/0001_b.sql': 'select 2;',
      }),
    ).toThrow(/duplicate migration version 1/);
  });

  it('throws on a gap in the version sequence', () => {
    expect(() =>
      discover({
        './migrations/0001_first.sql': 'select 1;',
        './migrations/0003_third.sql': 'select 3;',
      }),
    ).toThrow(/migration gap: expected version 2 but found 3/);
  });

  it('throws if numbering does not start at 1', () => {
    expect(() =>
      discover({ './migrations/0002_second.sql': 'select 2;' }),
    ).toThrow(/migration gap: expected version 1 but found 2/);
  });

  it('returns empty list for empty input', () => {
    expect(discover({})).toEqual([]);
  });
});

describe('migrate', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  // node:sqlite has no `db.pragma(name, { simple: true })`; the
  // ergonomic equivalent is prepare+get+access. Wrapped here so the
  // tests' assertions stay focused on the value, not the access shape.
  const userVersion = (): number =>
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;

  const initial: Migration = {
    version: 1,
    name: 'initial',
    sql: 'CREATE TABLE tracks (path TEXT PRIMARY KEY);',
  };
  const second: Migration = {
    version: 2,
    name: 'add_tags',
    sql: 'ALTER TABLE tracks ADD COLUMN tags TEXT;',
  };

  it('applies all migrations on a fresh DB and bumps user_version', () => {
    migrate(db, [initial, second]);
    expect(userVersion()).toBe(2);
    db.prepare('INSERT INTO tracks (path, tags) VALUES (?, ?)').run(
      '/tmp/x.mp3',
      'jazz',
    );
    expect(db.prepare('SELECT * FROM tracks').all()).toHaveLength(1);
  });

  it('is idempotent: running twice is a no-op', () => {
    migrate(db, [initial, second]);
    db.prepare('INSERT INTO tracks (path, tags) VALUES (?, ?)').run(
      '/tmp/y.mp3',
      null,
    );
    migrate(db, [initial, second]);
    expect(userVersion()).toBe(2);
    expect(db.prepare('SELECT * FROM tracks').all()).toHaveLength(1);
  });

  it('only applies pending migrations on a partially-migrated DB', () => {
    db.exec(initial.sql);
    db.exec('PRAGMA user_version = 1');

    migrate(db, [initial, second]);
    expect(userVersion()).toBe(2);
    const cols = db
      .prepare('PRAGMA table_info(tracks)')
      .all() as unknown as ReadonlyArray<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('tags');
  });

  it('rolls back failed migrations, leaving user_version unchanged', () => {
    const broken: Migration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE not_valid_sqlite (((;',
    };
    expect(() => migrate(db, [initial, broken])).toThrow(
      /migration 2 \(broken\) failed/,
    );
    expect(userVersion()).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as unknown as ReadonlyArray<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['tracks']);
  });

  it('handles empty migration list', () => {
    migrate(db, []);
    expect(userVersion()).toBe(0);
  });

  // --- Real migration chain (0001 → 0002 → 0003 → 0004) ----------------
  //
  // The unit tests above use synthetic fixtures so the runner is
  // exercised in isolation. The block below applies the *actual*
  // production migration files in order. The substantive
  // contracts covered:
  //   - 0003 admits `source='spotify'` (enum widening; SQL itself
  //     doesn't enforce, but a fresh insert proves nothing in the
  //     pre-0003 chain broke).
  //   - 0004 canonicalizes Spotify rows persisted under the
  //     pre-fix bug from `source_id='<bare-id>'` to
  //     `source_id='spotify:track:<id>'`. See
  //     `electron/main/db/migrations/0004_canonicalize_spotify_uri.sql`
  //     for the bug background.
  //
  // Vite-loaded as raw strings so the tests see exactly what
  // production does.

  it('applies the real migration chain and admits source=spotify (post-0003)', async () => {
    const files = import.meta.glob('./migrations/*.sql', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const real = discover(files);

    migrate(db, real);

    // user_version bumps to the highest discovered. Looked up
    // rather than hardcoded so a new migration landing (e.g. 0005)
    // doesn't break this test mechanically.
    const latest = real[real.length - 1]?.version ?? 0;
    expect(userVersion()).toBe(latest);

    // Insert a Spotify row in the post-fix shape (full URI as
    // source_id). Confirms the schema admits it end-to-end.
    db.prepare(
      `INSERT INTO tracks
         (source, source_id, path, title, artists, album,
          duration_ms, isrc, artwork_url, mtime, created_at)
       VALUES
         ('spotify', 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', NULL,
          'Blinding Lights', '["The Weeknd"]', 'After Hours',
          200040, NULL, NULL, 1234, 5678)`,
    ).run();

    const row = db
      .prepare("SELECT * FROM tracks WHERE source = 'spotify'")
      .get() as { title: string; source: string; source_id: string };
    expect(row.source).toBe('spotify');
    expect(row.source_id).toBe('spotify:track:0VjIjW4GlUZAMYd2vXMi3b');
    expect(row.title).toBe('Blinding Lights');
  });

  it('migration 0004 canonicalizes pre-fix bare-trackId rows', async () => {
    // Simulate a DB persisted under the pre-fix code: apply 0001
    // through 0003 only, insert a row with the buggy bare-trackId
    // source_id, then apply 0004 and verify the canonicalization.
    const files = import.meta.glob('./migrations/*.sql', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const all = discover(files);

    migrate(db, all.filter((m) => m.version <= 3));
    expect(userVersion()).toBe(3);

    db.prepare(
      `INSERT INTO tracks
         (source, source_id, path, title, artists, album,
          duration_ms, isrc, artwork_url, mtime, created_at)
       VALUES
         ('spotify', '0VjIjW4GlUZAMYd2vXMi3b', NULL, 'X',
          '["The Weeknd"]', NULL, 0, NULL, NULL, 1, 1)`,
    ).run();

    migrate(db, all.filter((m) => m.version === 4));
    expect(userVersion()).toBe(4);

    const row = db
      .prepare("SELECT source_id FROM tracks WHERE source = 'spotify'")
      .get() as { source_id: string };
    expect(row.source_id).toBe('spotify:track:0VjIjW4GlUZAMYd2vXMi3b');
  });

  it('migration 0004 is a no-op for rows already in URI shape', async () => {
    // A user who never hit the buggy save (fresh install on the
    // post-fix code) shouldn't have their rows mutated by 0004.
    // Also verifies the WHERE clause is idempotent (running 0004
    // a second time matches nothing).
    const files = import.meta.glob('./migrations/*.sql', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const all = discover(files);

    migrate(db, all.filter((m) => m.version <= 3));
    db.prepare(
      `INSERT INTO tracks
         (source, source_id, path, title, artists, album,
          duration_ms, isrc, artwork_url, mtime, created_at)
       VALUES
         ('spotify', 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', NULL,
          'X', '["Y"]', NULL, 0, NULL, NULL, 1, 1)`,
    ).run();

    migrate(db, all.filter((m) => m.version === 4));

    const row = db
      .prepare("SELECT source_id FROM tracks WHERE source = 'spotify'")
      .get() as { source_id: string };
    expect(row.source_id).toBe('spotify:track:0VjIjW4GlUZAMYd2vXMi3b');
  });

  // --- Migration 0005 (playlists) ----------------------------------------

  it('migration 0005 creates the playlists and playlist_tracks tables on a fresh DB', () => {
    const files = import.meta.glob('./migrations/*.sql', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const all = discover(files);

    migrate(db, all);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as ReadonlyArray<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('playlists');
    expect(tableNames).toContain('playlist_tracks');

    // The indexes 0005 ships should be present.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as unknown as ReadonlyArray<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_playlist_tracks_playlist');
    expect(indexNames).toContain('idx_playlist_tracks_track');
  });

  it('migration 0005 lands cleanly on a DB already at 0004 with existing tracks', () => {
    // Simulate a user who's been on the app since before 0005: apply
    // 0001-0004, insert a track row, then apply 0005. The existing
    // row should survive; the new tables should be empty but usable.
    const files = import.meta.glob('./migrations/*.sql', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const all = discover(files);

    migrate(db, all.filter((m) => m.version <= 4));
    db.prepare(
      `INSERT INTO tracks
         (source, source_id, path, title, artists, album,
          duration_ms, isrc, artwork_url, mtime, created_at)
       VALUES
         ('local', '/x.mp3', '/x.mp3', 'X', '["Y"]', NULL, 0, NULL, NULL, 1, 1)`,
    ).run();

    migrate(db, all.filter((m) => m.version === 5));
    expect(userVersion()).toBe(5);

    // Pre-existing row survived.
    const trackCount = (
      db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }
    ).c;
    expect(trackCount).toBe(1);

    // New tables are present and empty.
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM playlists').get() as { c: number }).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS c FROM playlist_tracks').get() as { c: number }
      ).c,
    ).toBe(0);
  });

  it('migration 0005 enforces playlist_tracks FK on inserts when foreign_keys=ON', () => {
    // The runner doesn't toggle foreign_keys; production's openDb
    // does. Mirror that here so this test verifies the post-migrate
    // schema is FK-enforced end to end.
    db.exec('PRAGMA foreign_keys = ON');
    const files = import.meta.glob('./migrations/*.sql', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    migrate(db, discover(files));

    // Insert a playlist_tracks row pointing at a nonexistent
    // playlist — should be rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO playlist_tracks
            (playlist_id, track_source, track_source_id, position, added_at)
           VALUES (?, 'local', '/nope.mp3', 0, ?)`,
        )
        .run(99999, Date.now()),
    ).toThrow(/FOREIGN KEY/);
  });
});
