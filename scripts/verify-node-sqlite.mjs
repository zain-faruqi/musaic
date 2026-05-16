// Phase-1 verification for the better-sqlite3 → node:sqlite migration:
// import node:sqlite and run a trivial query against an in-memory
// database. Print 'node:sqlite ok' on success, throw otherwise.
//
// Intended to be run under the same runtime tests use:
//   ELECTRON_RUN_AS_NODE=1 electron ./scripts/verify-node-sqlite.mjs
//
// Safe to delete once it has printed 'node:sqlite ok' on a real
// castlabs Electron 42 build — this is verification, not app code.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);');
const sum = db.prepare('SELECT SUM(x) AS s FROM t').get();
if (sum.s !== 6) throw new Error(`expected 6, got ${sum.s}`);
console.log('node:sqlite ok');
