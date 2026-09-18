/**
 * Schema and migrations for the extension's own SQLite database.
 *
 * The host opens the file with WAL and foreign keys on and then runs no
 * migrations of its own - an extension owns its schema completely. That means
 * the version bookkeeping has to live in a table here, and specifically NOT in
 * `PRAGMA user_version`: `ExtensionSqlGuard` rejects `PRAGMA` outright, so the
 * usual SQLite idiom is unavailable inside an extension. A one-row `meta`
 * table is the substitute.
 *
 * Every statement in this file is a literal. Nothing user-supplied is ever
 * concatenated into SQL anywhere in this extension - all values travel as
 * bound parameters - and this file is the only place SQL text is authored at
 * all, so that rule is checkable by reading one file.
 */

import type { IExtensionDatabase } from './bibleTypes';

/**
 * Ordered schema migrations. Append only; never edit a shipped entry.
 *
 * Index + 1 is the resulting schema version, so migration 0 produces version
 * 1. A user's database is brought forward by running every migration past its
 * recorded version, which is why they must stay stable once released.
 */
const MIGRATIONS: readonly string[][] = [
  // --- v1: the initial schema (locks, replay, four-state cards) -------------
  [
    `CREATE TABLE IF NOT EXISTS collection (
       id         INTEGER PRIMARY KEY,
       name       TEXT    NOT NULL,
       created_at INTEGER NOT NULL
     )`,

    `CREATE TABLE IF NOT EXISTS passage (
       id             INTEGER PRIMARY KEY,
       collection_id  INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
       module_id      TEXT    NOT NULL,
       start_verse_id INTEGER NOT NULL,
       end_verse_id   INTEGER NOT NULL,
       reference      TEXT    NOT NULL,
       verse_count    INTEGER NOT NULL,
       added_at       INTEGER NOT NULL
     )`,

    // The same range in two translations is two different memorisation tasks -
    // the words differ - so the uniqueness key includes the module.
    `CREATE UNIQUE INDEX IF NOT EXISTS passage_range_unique
       ON passage (collection_id, module_id, start_verse_id, end_verse_id)`,

    `CREATE TABLE IF NOT EXISTS card (
       id            INTEGER PRIMARY KEY,
       passage_id    INTEGER NOT NULL REFERENCES passage(id) ON DELETE CASCADE,
       rung          TEXT    NOT NULL,
       state         TEXT    NOT NULL,
       interval_step INTEGER NOT NULL DEFAULT -1,
       due_at        INTEGER,
       streak        INTEGER NOT NULL DEFAULT 0,
       last_score    REAL
     )`,

    `CREATE UNIQUE INDEX IF NOT EXISTS card_passage_rung_unique
       ON card (passage_id, rung)`,

    // The hot query is "what is due now", across every passage.
    `CREATE INDEX IF NOT EXISTS card_due_at ON card (due_at)`,

    // Attempt rows are never pruned. That is a deliberate rule, not an
    // oversight: the user asked to keep the data even where the UI does not
    // surface it, so that a statistic they decide they want later can be
    // computed over real history rather than starting from the day they
    // asked. Rows are tiny and bounded by how often a human can practise.
    `CREATE TABLE IF NOT EXISTS attempt (
       id            INTEGER PRIMARY KEY,
       card_id       INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
       at            INTEGER NOT NULL,
       score         REAL    NOT NULL,
       correct_first INTEGER NOT NULL,
       total_steps   INTEGER NOT NULL,
       replay        INTEGER NOT NULL DEFAULT 0
     )`,

    `CREATE INDEX IF NOT EXISTS attempt_card_at ON attempt (card_id, at)`,
    `CREATE INDEX IF NOT EXISTS attempt_at ON attempt (at)`,
  ],

  // --- v2: task 0004 - no locks, per-passage answer mode, resume, settings --
  //
  // `card.state` is left in place rather than dropped: the SQL guard rejects
  // `PRAGMA`, and an unconditional `ALTER TABLE ... DROP COLUMN` is newer than
  // some bundled SQLite builds are guaranteed to support, where `ADD COLUMN`
  // is universal. The column keeps being written (as a coarse, purely
  // informational label - see `MemoryStore.applySchedule`) but nothing reads
  // it back; `RungView.level` (from `ladder.ts#levelFromScore`) replaced it as
  // the source of truth for what the UI shows.
  [
    // `NULL` means "use the global default" - see the `setting` table below.
    `ALTER TABLE passage ADD COLUMN answer_mode TEXT`,

    // Wall-clock length of the session that produced this attempt. Nullable
    // because existing rows have no duration recorded.
    `ALTER TABLE attempt ADD COLUMN duration_ms INTEGER`,

    // A small, generic key/value table for user preferences that are not tied
    // to one passage. `meta` is deliberately not reused for this: `meta`
    // exists for the migration bookkeeping in this file and mixing schema
    // version tracking with user preferences in the same table has bitten
    // other extensions when the two need different lifecycles (a preference
    // survives `npm run clean`-and-reinstall in a way a schema version must
    // not be allowed to appear to).
    `CREATE TABLE IF NOT EXISTS setting (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,

    // Where an in-progress activity paused, so "Resume" can pick it back up -
    // written after each verse (or ordering step), not on every keystroke.
    // One row per card: starting a new attempt at a card overwrites its old
    // resume point, and finishing one clears it.
    `CREATE TABLE IF NOT EXISTS resume_state (
       card_id       INTEGER PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
       cursor        INTEGER NOT NULL,
       correct_first INTEGER NOT NULL,
       graded_units  INTEGER NOT NULL,
       updated_at    INTEGER NOT NULL
     )`,
  ],
];

/** The version a fresh database is brought to. */
export const SCHEMA_VERSION = MIGRATIONS.length;

const META_TABLE = `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/**
 * Bring `db` up to `SCHEMA_VERSION`, creating it if new.
 *
 * The whole upgrade runs inside one transaction so that a failure halfway
 * through leaves the database at its previous version rather than at a
 * half-applied one that no migration path can describe.
 */
export async function migrate(db: IExtensionDatabase): Promise<number> {
  await db.exec(META_TABLE);

  const row = await db.queryOne<{ value: string }>(
    `SELECT value FROM meta WHERE key = ?`,
    ['schema_version'],
  );
  const current = row ? Number(row.value) : 0;

  if (current >= SCHEMA_VERSION) return current;

  await db.transaction(async (tx) => {
    for (let v = current; v < MIGRATIONS.length; v++) {
      for (const statement of MIGRATIONS[v] as string[]) {
        await tx.exec(statement);
      }
    }
    // `INSERT OR REPLACE` rather than an UPDATE, because on a fresh database
    // there is no row to update and a silent zero-row UPDATE would leave the
    // version at 0 and re-run every migration on the next launch.
    await tx.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [
      'schema_version',
      String(SCHEMA_VERSION),
    ]);
  });

  return SCHEMA_VERSION;
}

/**
 * Ensure the single default collection exists and return its id.
 *
 * v0 ships one collection. The table is there because the design calls for
 * several, and retrofitting a foreign key onto rows that never had one is far
 * more painful than carrying a column that currently only ever holds one
 * value.
 */
export async function ensureDefaultCollection(
  db: IExtensionDatabase,
  name: string,
  now: number,
): Promise<number> {
  const existing = await db.queryOne<{ id: number }>(
    `SELECT id FROM collection ORDER BY id LIMIT 1`,
  );
  if (existing) return existing.id;

  const res = await db.run(`INSERT INTO collection (name, created_at) VALUES (?, ?)`, [
    name,
    now,
  ]);
  return Number(res.lastInsertRowid);
}
