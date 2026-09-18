/**
 * A real SQLite database implementing the host's `IExtensionDatabase`.
 *
 * Deliberately not a fake. What `store.ts` and `db.ts` are for is the
 * behaviour of SQL: whether a cascade actually removes the attempts of a
 * deleted passage, whether a unique index really rejects the second add,
 * whether a transaction rolls a half-applied migration back. A hand-written
 * in-memory double would encode my belief about each of those and then pass,
 * which is exactly the failure mode that makes a green suite worthless.
 *
 * The host's own mock (`createMockApi`) is not usable here either: its
 * `transaction` never invokes the work function and its KV does not round
 * trip, so DB-backed code tested through it silently no-ops.
 *
 * `better-sqlite3` is synchronous; `IExtensionDatabase` is async. The wrapper
 * bridges that and nothing else - no query rewriting, no dialect translation -
 * so the SQL under test is the SQL that will run in the app.
 */

import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import type { IExtensionDatabase } from '../src/bibleTypes';

export class SqliteHarness implements IExtensionDatabase {
  private readonly db: Db;
  /** Depth of nested `transaction()` calls, so savepoints nest correctly. */
  private depth = 0;
  private savepointCounter = 0;

  constructor(db?: Db) {
    // `:memory:` keeps each test isolated with no files to clean up. The host
    // opens a real file with WAL, which changes durability but not semantics.
    this.db = db ?? new Database(':memory:');
    this.db.pragma('foreign_keys = ON');
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async queryOne<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async run(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number | string }> {
    const info = this.db.prepare(sql).run(...(params as never[]));
    return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }

  /**
   * Run `work` in a transaction, rolling back if it throws.
   *
   * `better-sqlite3`'s own `db.transaction()` helper cannot be used: it
   * refuses to wrap a function that returns a promise, and every method here
   * is async. Savepoints are used rather than BEGIN/COMMIT so that a nested
   * transaction - which `migrate()` does not do today but easily could -
   * behaves rather than throwing "cannot start a transaction within a
   * transaction".
   */
  async transaction<T>(work: (tx: IExtensionDatabase) => Promise<T>): Promise<T> {
    const name = `sp_${this.savepointCounter++}`;
    this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = await work(this);
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Reopen the same data through a fresh instance, to simulate a restart. */
  reopenable(): Db {
    return this.db;
  }
}
