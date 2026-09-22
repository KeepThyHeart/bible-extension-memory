/**
 * Store and schema tests, run against a REAL SQLite database.
 *
 * Everything asserted here is a claim about SQL, not about TypeScript: whether
 * a cascade actually removes the attempts of a deleted passage, whether the
 * unique index really lets a duplicate add through as an existing row, whether
 * `ORDER BY ... CASE rung` genuinely beats row order, whether the values
 * written come back as the same types they went in as. A hand-written
 * in-memory double would encode my belief about each of those and then agree
 * with me, which is the failure mode that makes a green suite worthless. So
 * `SqliteHarness` is used throughout and no method on it is stubbed.
 *
 * ## v1: nothing is locked
 *
 * Task 0004 dropped the whole locked/unlocked distinction: every applicable
 * rung's card is created ready to practise, with `due_at = NULL` meaning
 * "never attempted" rather than "gated behind an earlier rung". A card only
 * becomes due once it has actually been scheduled by a real attempt - see
 * `dueCount and nextDueCard` below, which used to rely on v0's auto-unlock to
 * get a due card for free and now schedules one explicitly.
 */

import { describe, it, expect } from 'vitest';
import { SqliteHarness } from './sqliteHarness';
import { migrate, ensureDefaultCollection, SCHEMA_VERSION } from '../src/db';
import { MemoryStore } from '../src/store';
import { schedule, makeRng, INTERVALS_DAYS } from '../src/scheduler';
import { WELL_LEARNED_LEVEL } from '../src/ladder';
import type { IExtensionDatabase } from '../src/bibleTypes';
import type { Passage, Rung } from '../src/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed instant, so no assertion here depends on when the suite runs. */
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

const KJV = 'kjv';

/**
 * A real database that also counts how often the store opened a transaction.
 *
 * Subclassed rather than mocked so that every statement still executes against
 * SQLite - the count is an observation of real behaviour, not a substitute for
 * it. It exists for exactly one assertion: that a second `migrate()` on an
 * up-to-date database does not re-enter the migration transaction. "Nothing
 * changed" is not enough on its own, because every migration statement is a
 * `CREATE ... IF NOT EXISTS` (or an additive `ALTER TABLE`) and re-running
 * them all would also change nothing - right up until the day someone appends
 * a migration that is not idempotent.
 */
class CountingHarness extends SqliteHarness {
  transactions = 0;

  override async transaction<T>(work: (tx: IExtensionDatabase) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return super.transaction(work);
  }
}

/** A migrated database with the default collection, as the worker leaves it. */
async function freshStore(db?: SqliteHarness) {
  const harness = db ?? new SqliteHarness();
  await migrate(harness);
  const collectionId = await ensureDefaultCollection(harness, 'My plan', NOW);
  return { harness, collectionId, store: new MemoryStore(harness) };
}

/** Passage input in the shape `addPassage` wants, with sensible defaults. */
function passageInput(
  collectionId: number,
  startVerseId: number,
  verseCount: number,
  reference: string,
): Omit<Passage, 'id' | 'answerMode'> {
  return {
    collectionId,
    moduleId: KJV,
    startVerseId,
    endVerseId: startVerseId + verseCount - 1,
    reference,
    verseCount,
    addedAt: NOW,
  };
}

const rungsOf = (cards: { rung: Rung }[]) => cards.map((c) => c.rung).sort();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('migrate', () => {
  it('brings a fresh database to SCHEMA_VERSION', async () => {
    // The host runs no migrations of its own - an extension owns its schema
    // completely - so if this returns anything but the current version there
    // is no other layer that will notice.
    const harness = new SqliteHarness();
    expect(await migrate(harness)).toBe(SCHEMA_VERSION);

    const row = await harness.queryOne<{ value: string }>(
      `SELECT value FROM meta WHERE key = ?`,
      ['schema_version'],
    );
    expect(row?.value).toBe(String(SCHEMA_VERSION));
  });

  it('records the version in a table, not in PRAGMA user_version', async () => {
    // `ExtensionSqlGuard` rejects PRAGMA outright, so the usual SQLite idiom
    // is unavailable inside an extension and the one-row `meta` table is the
    // substitute. A refactor back to `PRAGMA user_version` would work
    // perfectly here in better-sqlite3 and be rejected by the host at runtime,
    // so the substitute is pinned as a fact about the schema.
    const harness = new SqliteHarness();
    await migrate(harness);
    const tables = await harness.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    expect(tables.map((t) => t.name)).toContain('meta');
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'attempt',
        'card',
        'collection',
        'meta',
        'passage',
        'setting',
        'resume_state',
      ]),
    );
  });

  it('adds the v2 columns to existing tables', async () => {
    // `answer_mode` and `duration_ms` are additive `ALTER TABLE`s, not part of
    // the original `CREATE TABLE`. If either were missed, every read through
    // `MemoryStore` would throw "no such column" the moment it touched a
    // database that pre-dates this migration - which in practice is every
    // database that existed before this task, since `ALTER TABLE` cannot be
    // expressed as `IF NOT EXISTS` and is easy to typo silently past.
    const harness = new SqliteHarness();
    await migrate(harness);
    const passageCols = await harness.query<{ name: string }>(`PRAGMA table_info(passage)`);
    expect(passageCols.map((c) => c.name)).toContain('answer_mode');
    const attemptCols = await harness.query<{ name: string }>(`PRAGMA table_info(attempt)`);
    expect(attemptCols.map((c) => c.name)).toContain('duration_ms');
  });

  it('is idempotent: a second run changes nothing and re-runs no migration', async () => {
    // Every launch of the app calls `migrate`. If the version check were
    // wrong, the migration transaction would re-execute on every start -
    // harmless for the `IF NOT EXISTS` statements, but the v2 `ALTER TABLE`s
    // are NOT idempotent on their own (SQLite throws "duplicate column name"
    // on a repeat), so this is the assertion that actually protects them.
    const harness = new CountingHarness();
    await migrate(harness);
    const afterFirst = harness.transactions;
    expect(afterFirst).toBe(1);

    // Real state, so that a re-run that dropped and recreated a table would
    // be visible as data loss as well as as a second transaction.
    const collectionId = await ensureDefaultCollection(harness, 'My plan', NOW);
    const store = new MemoryStore(harness);
    await store.addPassage(passageInput(collectionId, 43003016, 1, 'John 3:16'));

    expect(await migrate(harness)).toBe(SCHEMA_VERSION);
    expect(harness.transactions).toBe(afterFirst);

    expect(await store.listPassages(collectionId)).toHaveLength(1);
    const metaRows = await harness.query(`SELECT * FROM meta`);
    expect(metaRows).toHaveLength(1);
  });

  it('keeps foreign keys enforceable, which the cascades depend on', async () => {
    // The delete cascades below are declared in the schema but only take
    // effect when `foreign_keys` is on. The host opens the file that way and
    // the harness mirrors it; asserting the constraint actually bites here
    // means a later cascade failure can be read as a store bug rather than as
    // a pragma that was never set.
    const harness = new SqliteHarness();
    await migrate(harness);
    await expect(
      harness.run(
        `INSERT INTO card (passage_id, rung, state, interval_step, due_at, streak, last_score)
         VALUES (?, ?, ?, -1, NULL, 0, NULL)`,
        [9999, 'blanks', 'new'],
      ),
    ).rejects.toThrow();
  });
});

describe('ensureDefaultCollection', () => {
  it('creates one collection and returns the same id afterwards', async () => {
    // Called on every worker start. A second row would split the plan in two
    // and hide half the user's passages behind a collection id nothing looks
    // at, with no error anywhere.
    const harness = new SqliteHarness();
    await migrate(harness);
    const first = await ensureDefaultCollection(harness, 'My plan', NOW);
    const second = await ensureDefaultCollection(harness, 'Something else', NOW + DAY_MS);
    expect(second).toBe(first);
    expect(await harness.query(`SELECT * FROM collection`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Adding passages
// ---------------------------------------------------------------------------

describe('addPassage', () => {
  it('gives a multi-verse passage the ordering ladder', async () => {
    const { store, collectionId } = await freshStore();
    const { passage, created } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    expect(created).toBe(true);

    const cards = await store.listCards(passage.id);
    expect(rungsOf(cards)).toEqual(['blanks', 'firstletters', 'ordering']);
    // Exactly the ladder, nothing more: a `refmatch` row here would show up
    // as a rung the user can never reach on a passage that has no siblings to
    // be confused with.
    expect(cards).toHaveLength(3);
  });

  it('gives the first single verse in a plan only the two shared rungs', async () => {
    // Day one of every plan. Reordering one verse is meaningless and a
    // reference picker needs distractors, so neither first rung exists yet.
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const cards = await store.listCards(passage.id);
    expect(rungsOf(cards)).toEqual(['blanks', 'firstletters']);
  });

  it('creates every applicable rung ready to practise, none of them due yet', async () => {
    // Task 0004: nothing is locked, so there is no "first rung" special case
    // any more - every card starts identically, at `dueAt: null` ("never
    // attempted"), and stays that way until a real attempt schedules it.
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const cards = await store.listCards(passage.id);
    for (const card of cards) {
      expect(card.dueAt).toBeNull();
      expect(card.intervalStep).toBe(-1);
      expect(card.lastScore).toBeNull();
      expect(card.streak).toBe(0);
    }
  });

  it('returns the existing passage when the same range is added twice', async () => {
    // A unique index sits on (collection, module, start, end). Hitting it
    // would surface in the panel as an opaque RPC failure, but adding a
    // passage twice is a user slip rather than an error worth a dialog - the
    // second add should simply land on the passage they already have. This is
    // asserted against real SQL because the pre-check and the index have to
    // agree on what "the same range" means.
    const { store, collectionId } = await freshStore();
    const input = passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3');

    const first = await store.addPassage(input);
    const second = await store.addPassage({ ...input, addedAt: NOW + DAY_MS });

    expect(second.created).toBe(false);
    expect(second.passage.id).toBe(first.passage.id);
    // The original row is returned untouched rather than overwritten: the
    // first add is when the user started learning it, and resetting `addedAt`
    // would rewrite their history because they typed the reference again.
    expect(second.passage.addedAt).toBe(NOW);
    expect(await store.listPassages(collectionId)).toHaveLength(1);
    // And no second ladder was built on top of the first.
    expect(await store.listCards(first.passage.id)).toHaveLength(3);
  });

  it('treats the same range in a different module as a different passage', async () => {
    // The words differ between translations, so the cards differ - the same
    // reference in two modules is two memorisation tasks. The module is part
    // of the uniqueness key precisely so this add is not swallowed as a
    // duplicate.
    const { store, collectionId } = await freshStore();
    const input = passageInput(collectionId, 43003016, 1, 'John 3:16');
    await store.addPassage(input);
    const other = await store.addPassage({ ...input, moduleId: 'esv' });
    expect(other.created).toBe(true);
    expect(await store.listPassages(collectionId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The ladder is derived, not frozen
// ---------------------------------------------------------------------------

describe('syncLadders - the ladder re-syncs when the collection changes', () => {
  it('gives a lone verse a refmatch rung once a second passage exists', async () => {
    // The reason the ladder is derived on read rather than frozen into rows
    // at add time. A user adds one verse (no refmatch possible), then adds a
    // second - and the first verse has now gained an exercise it could not
    // have had a moment ago. Nothing else in the system would notice if this
    // stopped happening; the rung would just quietly never appear.
    const { store, collectionId } = await freshStore();
    const { passage: first } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    expect(rungsOf(await store.listCards(first.id))).toEqual(['blanks', 'firstletters']);

    await store.addPassage(passageInput(collectionId, 45008028, 1, 'Romans 8:28'));

    expect(rungsOf(await store.listCards(first.id))).toEqual([
      'blanks',
      'firstletters',
      'refmatch',
    ]);
  });

  it('creates a newly-applicable rung ready to practise, whether or not the passage has already been worked', async () => {
    // Nothing is locked any more, so there is no distinction left between "a
    // passage that has never been practised" and one that has: a rung that
    // just became applicable always starts at `dueAt: null`, full stop. This
    // replaces v0's two-sided test of that special case, which no longer
    // exists.
    const { store, collectionId } = await freshStore();
    const { passage: untouched } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const { passage: practised } = await store.addPassage(
      passageInput(collectionId, 45008028, 1, 'Romans 8:28'),
    );

    // Practise `practised`'s own blanks card for real before it gains
    // `refmatch` - this is the scenario where v0 would have kept a new rung
    // locked.
    const blanks = await store.getCard(practised.id, 'blanks');
    const result = schedule({
      intervalStep: blanks!.intervalStep,
      streak: blanks!.streak,
      score: 1,
      now: NOW,
      rng: makeRng(1),
    });
    await store.applySchedule(blanks!.id, result, 1);

    // A third passage gives BOTH existing passages a `refmatch` rung for the
    // first time.
    await store.addPassage(passageInput(collectionId, 45008030, 1, 'Romans 8:30'));

    const untouchedRefmatch = await store.getCard(untouched.id, 'refmatch');
    const practisedRefmatch = await store.getCard(practised.id, 'refmatch');
    expect(untouchedRefmatch).toMatchObject({ dueAt: null, intervalStep: -1 });
    expect(practisedRefmatch).toMatchObject({ dueAt: null, intervalStep: -1 });
  });

  it('does NOT delete a rung that has stopped applying', async () => {
    // Removing the second passage makes `refmatch` meaningless again - but
    // the user's attempts at it were real work on real material, and attempt
    // rows are never pruned. The row stays and is reported as inapplicable;
    // it simply stops being scheduled. A `syncLadders` that reconciled in
    // both directions would silently delete history every time a plan shrank.
    const { store, collectionId, harness } = await freshStore();
    const { passage: first } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const { passage: second } = await store.addPassage(
      passageInput(collectionId, 45008028, 1, 'Romans 8:28'),
    );

    const refmatch = await store.getCard(first.id, 'refmatch');
    expect(refmatch).toBeDefined();
    await store.recordAttempt({
      cardId: refmatch!.id,
      at: NOW,
      score: 1,
      correctFirst: 1,
      totalSteps: 1,
      durationMs: 4000,
    });

    await store.removePassage(second.id);

    const survivor = await store.getCard(first.id, 'refmatch');
    expect(survivor).toBeDefined();
    expect(survivor!.id).toBe(refmatch!.id);

    const attempts = await harness.query<{ id: number }>(
      `SELECT id FROM attempt WHERE card_id = ?`,
      [refmatch!.id],
    );
    expect(attempts).toHaveLength(1);
  });

  it('does not duplicate rows when run repeatedly', async () => {
    // `syncLadders` runs on every add and every remove, so it runs many times
    // over a plan's life. The `card_passage_rung_unique` index would throw on
    // a duplicate insert rather than corrupting anything, but that throw
    // would reach the panel as an opaque failure on an ordinary "add
    // passage", so the guard is asserted rather than relied on.
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    await store.syncLadders(collectionId);
    await store.syncLadders(collectionId);
    expect(await store.listCards(passage.id)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The refmatch sibling count is plan-wide, not per-list (P4/Decision 14)
// ---------------------------------------------------------------------------

describe('plan-wide sibling count', () => {
  it('countAllPassages and listAllPassages see every collection, not just one', async () => {
    const { store, collectionId } = await freshStore();
    await store.addPassage(passageInput(collectionId, 43003016, 1, 'John 3:16'));
    const other = await store.createCollection('List B', NOW);
    await store.addPassage(passageInput(other.id, 45008028, 1, 'Romans 8:28'));
    await store.addPassage(passageInput(other.id, 19023001, 1, 'Psalm 23:1'));

    expect(await store.countAllPassages()).toBe(3);
    expect(await store.listAllPassages()).toHaveLength(3);
    // The collection-scoped read is unaffected - it is what the plan view
    // itself still uses to decide WHICH passages to show.
    expect(await store.listPassages(collectionId)).toHaveLength(1);
  });

  it("gives a passage refmatch once a sibling exists in ANOTHER list, once its own list is re-synced", async () => {
    // `addPassage` only calls `syncLadders` for the collection it touched
    // (see its own note, and `syncLadders`'s), so list A's ladder is stale
    // until something re-syncs list A itself - `syncLadders(collectionId)` is
    // that catch-up, and this asserts it uses the GLOBAL count once it runs,
    // not list A's own (still just one passage).
    const { store, collectionId } = await freshStore();
    const { passage: onlyInA } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    expect(rungsOf(await store.listCards(onlyInA.id))).toEqual(['blanks', 'firstletters']);

    const other = await store.createCollection('List B', NOW);
    await store.addPassage(passageInput(other.id, 45008028, 1, 'Romans 8:28'));

    // List B's own passage gets `refmatch` too, and for the same reason: the
    // plan-wide count (2) is what `addPassage`'s own `syncLadders` call used
    // when it built List B's ladder just now.
    const listBCards = await store.listCards((await store.listPassages(other.id))[0]!.id);
    expect(rungsOf(listBCards)).toEqual(['blanks', 'firstletters', 'refmatch']);

    await store.syncLadders(collectionId);
    expect(rungsOf(await store.listCards(onlyInA.id))).toEqual([
      'blanks',
      'firstletters',
      'refmatch',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe('removePassage', () => {
  it('cascades to the passage\'s cards and their attempts', async () => {
    // The one place the never-prune rule yields. Keeping the attempt history
    // of a passage the user explicitly removed would mean their delete did
    // not delete, and the Analytics screen would go on counting work against
    // material that is gone. This only works if the FK cascade is real, which
    // is why it is asserted against SQLite rather than against a fake.
    const { store, collectionId, harness } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const cards = await store.listCards(passage.id);
    for (const card of cards) {
      await store.recordAttempt({
        cardId: card.id,
        at: NOW,
        score: 0.9,
        correctFirst: 9,
        totalSteps: 10,
        durationMs: 12000,
      });
    }
    expect(await harness.query(`SELECT id FROM attempt`)).toHaveLength(3);

    await store.removePassage(passage.id);

    expect(await store.getPassage(passage.id)).toBeUndefined();
    expect(await harness.query(`SELECT id FROM card WHERE passage_id = ?`, [passage.id])).toHaveLength(0);
    // The cascade has to reach two levels: passage -> card -> attempt. A
    // schema that cascaded only the first level would leave orphan attempt
    // rows that `analytics()` still counts.
    expect(await harness.query(`SELECT id FROM attempt`)).toHaveLength(0);
  });

  it('leaves other passages and their history untouched', async () => {
    const { store, collectionId, harness } = await freshStore();
    const { passage: keep } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const { passage: drop } = await store.addPassage(
      passageInput(collectionId, 45008028, 1, 'Romans 8:28'),
    );
    const keepCard = await store.getCard(keep.id, 'blanks');
    await store.recordAttempt({
      cardId: keepCard!.id,
      at: NOW,
      score: 1,
      correctFirst: 3,
      totalSteps: 3,
      durationMs: null,
    });

    await store.removePassage(drop.id);

    expect(await store.getPassage(keep.id)).toBeDefined();
    expect(
      await harness.query(`SELECT id FROM attempt WHERE card_id = ?`, [keepCard!.id]),
    ).toHaveLength(1);
  });

  it('is a no-op for a passage that is already gone', async () => {
    // Two panels open on the same plan can both send `removePassage` for the
    // same row. The second must not throw across the RPC boundary.
    const { store } = await freshStore();
    await expect(store.removePassage(4242)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Answer mode
// ---------------------------------------------------------------------------

describe('answer mode', () => {
  it('defaults to firstLetter with no setting written', async () => {
    const { store } = await freshStore();
    expect(await store.getDefaultAnswerMode()).toBe('firstLetter');
  });

  it('persists a changed global default', async () => {
    const { store } = await freshStore();
    await store.setDefaultAnswerMode('fullWord');
    expect(await store.getDefaultAnswerMode()).toBe('fullWord');
  });

  it('lets a passage override the global default, and clear the override', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    expect(passage.answerMode).toBeNull();

    await store.setPassageAnswerMode(passage.id, 'fullWord');
    expect((await store.getPassage(passage.id))!.answerMode).toBe('fullWord');

    await store.setPassageAnswerMode(passage.id, null);
    expect((await store.getPassage(passage.id))!.answerMode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Passage sort order (M4)
// ---------------------------------------------------------------------------

describe('passage sort order', () => {
  it('defaults to bible order with no setting written', async () => {
    const { store } = await freshStore();
    expect(await store.getPassageSortOrder()).toBe('bible');
  });

  it('persists a changed sort order', async () => {
    const { store } = await freshStore();
    await store.setPassageSortOrder('need');
    expect(await store.getPassageSortOrder()).toBe('need');
  });

  it('round-trips back to bible order explicitly', async () => {
    const { store } = await freshStore();
    await store.setPassageSortOrder('need');
    await store.setPassageSortOrder('bible');
    expect(await store.getPassageSortOrder()).toBe('bible');
  });
});

// ---------------------------------------------------------------------------
// Collection name (P1)
// ---------------------------------------------------------------------------

describe('collection name', () => {
  it('reads back the name ensureDefaultCollection first wrote', async () => {
    const { store, collectionId } = await freshStore();
    expect(await store.getCollectionName(collectionId)).toBe('My plan');
  });

  it('persists a rename', async () => {
    const { store, collectionId } = await freshStore();
    await store.renameCollection(collectionId, 'Sunday school memory verses');
    expect(await store.getCollectionName(collectionId)).toBe('Sunday school memory verses');
  });

  it('falls back to empty for a collection that does not exist', async () => {
    const { store } = await freshStore();
    expect(await store.getCollectionName(99999)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Multi-list data model (P4)
// ---------------------------------------------------------------------------

describe('listCollections', () => {
  it('lists the default collection with a zero passage count', async () => {
    const { store, collectionId } = await freshStore();
    expect(await store.listCollections()).toEqual([
      { id: collectionId, name: 'My plan', passageCount: 0 },
    ]);
  });

  it("counts each collection's own passages, not the whole plan's", async () => {
    const { store, collectionId } = await freshStore();
    await store.addPassage(passageInput(collectionId, 43003016, 1, 'John 3:16'));
    await store.addPassage(passageInput(collectionId, 45008028, 1, 'Romans 8:28'));
    const other = await store.createCollection('Memory verses for kids', NOW);
    await store.addPassage(passageInput(other.id, 19023001, 3, 'Psalm 23:1-3'));

    expect(await store.listCollections()).toEqual([
      { id: collectionId, name: 'My plan', passageCount: 2 },
      { id: other.id, name: 'Memory verses for kids', passageCount: 1 },
    ]);
  });
});

describe('createCollection', () => {
  it('creates an empty list with the given name', async () => {
    const { store } = await freshStore();
    const created = await store.createCollection('Sunday school', NOW);
    expect(created.name).toBe('Sunday school');
    expect(await store.getCollectionName(created.id)).toBe('Sunday school');
    expect(await store.listPassages(created.id)).toEqual([]);
  });

  it('gives each new list its own id, distinct from every other list', async () => {
    const { store, collectionId } = await freshStore();
    const a = await store.createCollection('List A', NOW);
    const b = await store.createCollection('List B', NOW + DAY_MS);
    expect(new Set([collectionId, a.id, b.id]).size).toBe(3);
  });
});

describe('deleteCollection', () => {
  it("cascades to the list's own passages, their cards and their attempts", async () => {
    // Mirrors `removePassage`'s own cascade test, one level up: deleting a
    // whole list has to reach passage -> card -> attempt just as deleting one
    // passage does, since `collection`'s cascade onto `passage` is what P4
    // relies on to avoid any migration - see `db.ts`'s schema.
    const { store, harness } = await freshStore();
    const other = await store.createCollection('List B', NOW);
    const { passage } = await store.addPassage(passageInput(other.id, 19023001, 3, 'Psalm 23:1-3'));
    const cards = await store.listCards(passage.id);
    for (const card of cards) {
      await store.recordAttempt({
        cardId: card.id,
        at: NOW,
        score: 1,
        correctFirst: 1,
        totalSteps: 1,
        durationMs: 1000,
      });
    }
    expect(await harness.query(`SELECT id FROM attempt`)).toHaveLength(3);

    await store.deleteCollection(other.id);

    expect(await harness.query(`SELECT id FROM collection WHERE id = ?`, [other.id])).toHaveLength(0);
    expect(
      await harness.query(`SELECT id FROM passage WHERE collection_id = ?`, [other.id]),
    ).toHaveLength(0);
    expect(await harness.query(`SELECT id FROM card WHERE passage_id = ?`, [passage.id])).toHaveLength(0);
    expect(await harness.query(`SELECT id FROM attempt`)).toHaveLength(0);
  });

  it('leaves other lists and their passages untouched', async () => {
    const { store, collectionId } = await freshStore();
    const { passage: keep } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const other = await store.createCollection('List B', NOW);
    await store.addPassage(passageInput(other.id, 45008028, 1, 'Romans 8:28'));

    await store.deleteCollection(other.id);

    expect(await store.getPassage(keep.id)).toBeDefined();
    expect(await store.listCollections()).toEqual([
      { id: collectionId, name: 'My plan', passageCount: 1 },
    ]);
  });

  it('is a no-op for a list that is already gone', async () => {
    const { store } = await freshStore();
    await expect(store.deleteCollection(99999)).resolves.toBeUndefined();
  });
});

describe('active collection', () => {
  it('defaults to the collection ensureDefaultCollection created, with no setting ever stored', async () => {
    // The fresh-install AND the upgrade-from-before-P4 case: either way, the
    // only collection that exists yet is the one `ensureDefaultCollection`
    // resolved, so the active-collection setting starting unset has to land
    // on that same row rather than on nothing.
    const { store, collectionId } = await freshStore();
    expect(await store.getActiveCollectionId()).toBe(collectionId);
  });

  it('persists a switch to another list', async () => {
    const { store } = await freshStore();
    const other = await store.createCollection('List B', NOW);
    await store.setActiveCollectionId(other.id);
    expect(await store.getActiveCollectionId()).toBe(other.id);
  });

  it('falls back to the oldest surviving list once the active one is deleted', async () => {
    // `main.ts`'s `deleteCollection` handler reassigns the setting explicitly
    // when the deleted list was active, but this is what makes that a belt
    // rather than the only strap: even a stale stored id that no longer names
    // a row must not leave `getActiveCollectionId` pointing at nothing.
    const { store, collectionId } = await freshStore();
    const other = await store.createCollection('List B', NOW);
    await store.setActiveCollectionId(other.id);
    expect(await store.getActiveCollectionId()).toBe(other.id);

    await store.deleteCollection(other.id);

    expect(await store.getActiveCollectionId()).toBe(collectionId);
  });

  it('returns undefined only once no collection exists at all', async () => {
    const { store, harness, collectionId } = await freshStore();
    await store.deleteCollection(collectionId);
    expect(await harness.query(`SELECT * FROM collection`)).toHaveLength(0);
    expect(await store.getActiveCollectionId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Resume state
// ---------------------------------------------------------------------------

describe('resume state', () => {
  it('is absent until a session saves one', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const card = await store.getCard(passage.id, 'blanks');
    expect(await store.getResume(card!.id)).toBeUndefined();
  });

  it('is written, overwritten and cleared by card id', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const card = await store.getCard(passage.id, 'blanks');

    await store.saveResume(card!.id, { cursor: 1, correctFirst: 1, gradedUnits: 1 }, NOW);
    expect(await store.getResume(card!.id)).toMatchObject({ cursor: 1, correctFirst: 1, gradedUnits: 1 });

    // A later verse overwrites the row rather than accumulating a second one -
    // one row per card is the whole contract `resume_state`'s primary key
    // enforces.
    await store.saveResume(card!.id, { cursor: 2, correctFirst: 2, gradedUnits: 2 }, NOW + 1000);
    const updated = await store.getResume(card!.id);
    expect(updated?.cursor).toBe(2);

    await store.clearResume(card!.id);
    expect(await store.getResume(card!.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Due queries
// ---------------------------------------------------------------------------

describe('dueCount and nextDueCard', () => {
  it('never counts a card until it has been attempted, because its due date starts NULL', async () => {
    const { store, collectionId, harness } = await freshStore();
    await store.addPassage(passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'));

    const all = await harness.query<{ n: number }>(`SELECT COUNT(*) AS n FROM card`);
    expect(all[0]!.n).toBe(3);
    expect(await store.dueCount(NOW)).toBe(0);
  });

  it('does not count a card whose due date is still in the future', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const card = await store.getCard(passage.id, 'ordering');
    const result = schedule({
      intervalStep: -1,
      streak: 0,
      score: 1,
      now: NOW,
      rng: makeRng(3),
    });
    await store.applySchedule(card!.id, result, 1);

    expect(await store.dueCount(NOW)).toBe(0);
    // One day out plus jitter; well inside two days at the lowest rung.
    expect(await store.dueCount(NOW + 2 * DAY_MS)).toBe(1);
    expect(await store.nextDueCard(NOW)).toBeUndefined();
  });

  it('works a passage bottom-up rather than in row order', async () => {
    // The scenario is constructed so that row order and ladder order
    // disagree. A single verse added alone gets `blanks` at a lower row id;
    // a second passage then grants it `refmatch`, inserted later and so with
    // a HIGHER row id, while sitting LOWER on the ladder. Both are scheduled
    // due at the same instant. Ordering by id would ask for the missing
    // words before asking which reference this even is, which is backwards -
    // hence the CASE expression this test exists to protect.
    const { store, collectionId } = await freshStore();
    const { passage: first } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    await store.addPassage(passageInput(collectionId, 45008028, 1, 'Romans 8:28'));

    const blanks = await store.getCard(first.id, 'blanks');
    const refmatch = await store.getCard(first.id, 'refmatch');
    expect(refmatch!.id).toBeGreaterThan(blanks!.id);

    await store.applySchedule(blanks!.id, schedule({ intervalStep: -1, streak: 0, score: 1, now: NOW, rng: makeRng(1) }), 1);
    await store.applySchedule(refmatch!.id, schedule({ intervalStep: -1, streak: 0, score: 1, now: NOW, rng: makeRng(1) }), 1);
    const blanksAfter = await store.getCard(first.id, 'blanks');
    const refmatchAfter = await store.getCard(first.id, 'refmatch');
    expect(blanksAfter!.dueAt).toBe(refmatchAfter!.dueAt);

    const next = await store.nextDueCard(blanksAfter!.dueAt!);
    expect(next?.card.rung).toBe('refmatch');
    expect(next?.card.id).toBe(refmatch!.id);
    // And the passage travels with the card, so the caller never has to look
    // it up separately and risk a null it did not expect.
    expect(next?.passage.id).toBe(first.id);
  });

  it('prefers the earliest due date across passages', async () => {
    // Due date dominates rung position: an overdue `firstletters` on one
    // passage comes before a just-due `ordering` on another. Otherwise the
    // rung ordering would silently become a passage priority.
    const { store, collectionId, harness } = await freshStore();
    const { passage: a } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const { passage: b } = await store.addPassage(
      passageInput(collectionId, 45008028, 2, 'Romans 8:28-29'),
    );

    const aFirstLetters = await store.getCard(a.id, 'firstletters');
    await harness.run(`UPDATE card SET due_at = ? WHERE id = ?`, [NOW - DAY_MS, aFirstLetters!.id]);

    const next = await store.nextDueCard(NOW);
    expect(next?.card.id).toBe(aFirstLetters!.id);
    expect(next?.passage.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  it('counts every due card across the whole plan', async () => {
    const { store, collectionId, harness } = await freshStore();
    const { passage: a } = await store.addPassage(passageInput(collectionId, 43003016, 1, 'John 3:16'));
    const { passage: b } = await store.addPassage(passageInput(collectionId, 45008028, 1, 'Romans 8:28'));

    // Three cards, across both passages, made due by hand.
    const aBlanks = await store.getCard(a.id, 'blanks');
    const aRefmatch = await store.getCard(a.id, 'refmatch');
    const bRefmatch = await store.getCard(b.id, 'refmatch');
    await harness.run(`UPDATE card SET due_at = ? WHERE id IN (?, ?, ?)`, [
      NOW,
      aBlanks!.id,
      aRefmatch!.id,
      bRefmatch!.id,
    ]);

    expect(await store.dueCount(NOW)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe('analytics', () => {
  it('reports zeros and empties on a plan with no attempts', async () => {
    const { store, collectionId } = await freshStore();
    await store.addPassage(passageInput(collectionId, 43003016, 1, 'John 3:16'));
    const view = await store.analytics(NOW);
    expect(view.streakDays).toBe(0);
    expect(view.versesLearned).toBe(0);
    expect(view.passagesWellLearned).toBe(0);
    expect(view.recentlyReached).toEqual([]);
    expect(view.calendar).toHaveLength(35);
  });

  it('counts a passage as well learned, and its verses, once any applicable rung reaches level 4', async () => {
    // "Harder carries down": the passage counts as a whole once its BEST rung
    // clears the bar, regardless of the other rungs' own history.
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const firstletters = await store.getCard(passage.id, 'firstletters');
    await store.applySchedule(firstletters!.id, schedule({ intervalStep: -1, streak: 0, score: 0.95, now: NOW, rng: makeRng(1) }), 0.95);

    const view = await store.analytics(NOW);
    expect(view.passagesWellLearned).toBe(1);
    expect(view.versesLearned).toBe(3);
  });

  it('does not count a passage whose best rung is still below level 4', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const blanks = await store.getCard(passage.id, 'blanks');
    await store.applySchedule(blanks!.id, schedule({ intervalStep: -1, streak: 0, score: 0.6, now: NOW, rng: makeRng(1) }), 0.6);

    const view = await store.analytics(NOW);
    expect(view.passagesWellLearned).toBe(0);
    expect(view.versesLearned).toBe(0);
  });

  it('counts a run of consecutive days ending today as the streak', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const blanks = await store.getCard(passage.id, 'blanks');
    await store.recordAttempt({ cardId: blanks!.id, at: NOW, score: 1, correctFirst: 1, totalSteps: 1, durationMs: 1000 });
    await store.recordAttempt({ cardId: blanks!.id, at: NOW - DAY_MS, score: 1, correctFirst: 1, totalSteps: 1, durationMs: 1000 });
    await store.recordAttempt({ cardId: blanks!.id, at: NOW - 2 * DAY_MS, score: 1, correctFirst: 1, totalSteps: 1, durationMs: 1000 });
    // A gap: no attempt three days ago breaks the streak there.
    await store.recordAttempt({ cardId: blanks!.id, at: NOW - 4 * DAY_MS, score: 1, correctFirst: 1, totalSteps: 1, durationMs: 1000 });

    const view = await store.analytics(NOW);
    expect(view.streakDays).toBe(3);
  });

  it('lists recently reached milestones newest first, capped at five', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );
    const blanks = await store.getCard(passage.id, 'blanks');
    // First crossing of the well-learned bar, then a second attempt that
    // should NOT produce a second milestone for the same card.
    await store.recordAttempt({ cardId: blanks!.id, at: NOW - DAY_MS, score: 0.95, correctFirst: 19, totalSteps: 20, durationMs: 1000 });
    await store.recordAttempt({ cardId: blanks!.id, at: NOW, score: 1, correctFirst: 20, totalSteps: 20, durationMs: 1000 });

    const view = await store.analytics(NOW);
    expect(view.recentlyReached).toHaveLength(1);
    expect(view.recentlyReached[0]).toMatchObject({
      passageId: passage.id,
      reference: 'John 3:16',
      rung: 'blanks',
      level: WELL_LEARNED_LEVEL,
      at: NOW - DAY_MS,
    });
  });

  it('reports the next round-five milestone and how far off it is', async () => {
    const { store, collectionId } = await freshStore();
    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const firstletters = await store.getCard(passage.id, 'firstletters');
    await store.applySchedule(firstletters!.id, schedule({ intervalStep: -1, streak: 0, score: 1, now: NOW, rng: makeRng(1) }), 1);

    const view = await store.analytics(NOW);
    expect(view.versesLearned).toBe(3);
    expect(view.nextMilestone).toEqual({ versesLearned: 5, toGo: 2 });
  });

  it('aggregates across every list, not just one (P4/Decision 14)', async () => {
    // A user's sense of progress is about their whole memorization practice,
    // not whichever list happens to be active - see `MemoryStore#analytics`'s
    // own note. `analytics` takes no `collectionId` any more; this is the
    // assertion that it really did stop scoping to one.
    const { store, collectionId } = await freshStore();
    const { passage: inDefault } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const firstletters = await store.getCard(inDefault.id, 'firstletters');
    await store.applySchedule(
      firstletters!.id,
      schedule({ intervalStep: -1, streak: 0, score: 1, now: NOW, rng: makeRng(1) }),
      1,
    );

    const other = await store.createCollection('List B', NOW);
    const { passage: inOther } = await store.addPassage(
      passageInput(other.id, 43003016, 1, 'John 3:16'),
    );
    const blanks = await store.getCard(inOther.id, 'blanks');
    await store.applySchedule(
      blanks!.id,
      schedule({ intervalStep: -1, streak: 0, score: 0.95, now: NOW, rng: makeRng(1) }),
      0.95,
    );

    const view = await store.analytics(NOW);
    expect(view.passagesWellLearned).toBe(2);
    expect(view.versesLearned).toBe(4); // 3 (Psalm 23:1-3) + 1 (John 3:16)
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence across a restart', () => {
  it('reads every field back identically through a fresh store on the same database', async () => {
    // This is the assertion a fake database cannot make. Everything above
    // could pass against an in-memory object graph that never serialised
    // anything; only a real round trip catches a REAL column that comes back
    // as a string, a boolean written as `true` into an INTEGER column, or a
    // null that becomes a zero. `last_score` in particular is a float, and
    // `due_at` a nullable integer - both are exactly the shapes that survive
    // a fake and change under SQLite.
    const harness = new SqliteHarness();
    const { store, collectionId } = await freshStore(harness);

    const { passage } = await store.addPassage(
      passageInput(collectionId, 19023001, 3, 'Psalm 23:1-3'),
    );
    const ordering = await store.getCard(passage.id, 'ordering');
    const result = schedule({
      intervalStep: 2,
      streak: 1,
      score: 0.875,
      now: NOW,
      rng: makeRng(5),
    });
    await store.applySchedule(ordering!.id, result, 0.875);
    await store.recordAttempt({
      cardId: ordering!.id,
      at: NOW,
      score: 0.875,
      correctFirst: 7,
      totalSteps: 8,
      durationMs: 45000,
    });
    await store.recordAttempt({
      cardId: ordering!.id,
      at: NOW + 1,
      score: 0.25,
      correctFirst: 2,
      totalSteps: 8,
      durationMs: null,
    });

    const before = {
      passages: await store.listPassages(collectionId),
      cards: await store.listCards(passage.id),
      due: await store.dueCount(NOW + 30 * DAY_MS),
      analytics: await store.analytics(NOW),
      attemptRows: await harness.query(`SELECT * FROM attempt WHERE card_id = ? ORDER BY id`, [ordering!.id]),
    };

    // A fresh wrapper and a fresh store over the SAME database file - the
    // worker restarting, with nothing carried over in memory.
    const reopened = new SqliteHarness(harness.reopenable());
    const restarted = new MemoryStore(reopened);
    // The schema check runs on every start; it must find the database current
    // rather than trying to build it again.
    expect(await migrate(reopened)).toBe(SCHEMA_VERSION);

    expect(await restarted.listPassages(collectionId)).toEqual(before.passages);
    expect(await restarted.listCards(passage.id)).toEqual(before.cards);
    expect(await restarted.dueCount(NOW + 30 * DAY_MS)).toBe(before.due);
    expect(await restarted.analytics(NOW)).toEqual(before.analytics);
    expect(
      await reopened.query(`SELECT * FROM attempt WHERE card_id = ? ORDER BY id`, [ordering!.id]),
    ).toEqual(before.attemptRows);

    // Spot-check the types themselves, not just equality with a value that
    // could have been wrong in the same way on both sides of the restart.
    const card = await restarted.getCard(passage.id, 'ordering');
    expect(typeof card!.dueAt).toBe('number');
    expect(typeof card!.lastScore).toBe('number');
    expect(card!.lastScore).toBeCloseTo(0.875, 10);
    expect(card!.intervalStep).toBe(result.intervalStep);
    expect(card!.streak).toBe(result.streak);
  });

  it('keeps an unattempted card\'s null due date null across a restart', async () => {
    // A null that came back as 0 would make every untouched rung in the plan
    // due at the epoch, i.e. due now, on the first restart after the user
    // added anything. That is a silent, total collapse of the schedule and it
    // is only observable through a real column.
    const harness = new SqliteHarness();
    const { store, collectionId } = await freshStore(harness);
    const { passage } = await store.addPassage(
      passageInput(collectionId, 43003016, 1, 'John 3:16'),
    );

    const restarted = new MemoryStore(new SqliteHarness(harness.reopenable()));
    const untouched = await restarted.getCard(passage.id, 'firstletters');
    expect(untouched!.dueAt).toBeNull();
    expect(untouched!.lastScore).toBeNull();
    // Nothing was ever scheduled, so nothing is ever due - not even a year on.
    expect(await restarted.dueCount(NOW + 365 * DAY_MS)).toBe(0);
  });
});
