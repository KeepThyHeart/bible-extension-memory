/**
 * Every read and write the extension makes against its own database.
 *
 * No SQL exists outside this file and `db.ts`, and no value is ever
 * concatenated into a statement - all of them are bound parameters. A
 * reference typed by the user reaches this layer as a string and must never
 * become part of a query's text.
 *
 * The store owns rows. It deliberately owns no scoring and no interval
 * arithmetic: those live in `ladder.ts` and `scheduler.ts` as pure functions
 * so they can be tested without a database, and so that a change to the
 * ladder cannot quietly become a change to persistence.
 */

import type { IExtensionDatabase } from './bibleTypes';
import type {
  AnalyticsView,
  AnswerMode,
  AttemptRow,
  Card,
  CollectionView,
  Milestone,
  Passage,
  PassageSortOrder,
  Rung,
} from './types';
import { applicableRungs, levelFromScore, WELL_LEARNED_LEVEL } from './ladder';
import type { ScheduleResult } from './scheduler';

/** Row shapes as SQLite returns them: snake_case, integers for booleans. */
interface PassageRow {
  id: number;
  collection_id: number;
  module_id: string;
  start_verse_id: number;
  end_verse_id: number;
  reference: string;
  verse_count: number;
  added_at: number;
  answer_mode: string | null;
  /** Epoch ms, or `null` while the passage is in the plan. See Decision 16 (task 0028/P6). */
  deleted_at: number | null;
}

interface CardRow {
  id: number;
  passage_id: number;
  rung: string;
  state: string;
  interval_step: number;
  due_at: number | null;
  streak: number;
  last_score: number | null;
}

export interface ResumeRow {
  cardId: number;
  cursor: number;
  correctFirst: number;
  gradedUnits: number;
  updatedAt: number;
}

interface ResumeSqlRow {
  card_id: number;
  cursor: number;
  correct_first: number;
  graded_units: number;
  updated_at: number;
}

function toPassage(r: PassageRow): Passage {
  return {
    id: r.id,
    collectionId: r.collection_id,
    moduleId: r.module_id,
    startVerseId: r.start_verse_id,
    endVerseId: r.end_verse_id,
    reference: r.reference,
    verseCount: r.verse_count,
    addedAt: r.added_at,
    answerMode: r.answer_mode === 'firstLetter' || r.answer_mode === 'fullWord' ? r.answer_mode : null,
  };
}

function toCard(r: CardRow): Card {
  return {
    id: r.id,
    passageId: r.passage_id,
    rung: r.rung as Rung,
    intervalStep: r.interval_step,
    dueAt: r.due_at,
    streak: r.streak,
    lastScore: r.last_score,
  };
}

function toResume(r: ResumeSqlRow): ResumeRow {
  return {
    cardId: r.card_id,
    cursor: r.cursor,
    correctFirst: r.correct_first,
    gradedUnits: r.graded_units,
    updatedAt: r.updated_at,
  };
}

/** Label written to `card.state` - display-only, kept for humans reading the DB directly. */
function stateLabelFor(level: number): string {
  if (level >= WELL_LEARNED_LEVEL) return 'mastered';
  if (level > 0) return 'learning';
  return 'new';
}

const DEFAULT_ANSWER_MODE: AnswerMode = 'firstLetter';
const SETTING_DEFAULT_ANSWER_MODE = 'defaultAnswerMode';

const DEFAULT_PASSAGE_SORT_ORDER: PassageSortOrder = 'bible';
const SETTING_PASSAGE_SORT_ORDER = 'passageSortOrder';

const SETTING_ACTIVE_COLLECTION = 'activeCollectionId';

export class MemoryStore {
  constructor(private readonly db: IExtensionDatabase) {}

  // -- collections ------------------------------------------------------------

  /**
   * The collection's display name, as `ensureDefaultCollection` (`db.ts`)
   * first wrote it or a later `renameCollection` left it.
   *
   * Falls back to `''` rather than throwing on a missing row - `collectionId`
   * always comes from `ensureDefaultCollection`'s own return value in
   * practice, so a miss here would mean the row was deleted out from under
   * the extension, not a bug worth crashing `getPlan` over.
   */
  async getCollectionName(collectionId: number): Promise<string> {
    const row = await this.db.queryOne<{ name: string }>(
      `SELECT name FROM collection WHERE id = ?`,
      [collectionId],
    );
    return row?.name ?? '';
  }

  /**
   * Renames a collection - the one-line `UPDATE` Decision 14 describes for the
   * P1 shell, ahead of the real multi-list CRUD (create/delete) that stays
   * P4's job.
   */
  async renameCollection(collectionId: number, name: string): Promise<void> {
    await this.db.run(`UPDATE collection SET name = ? WHERE id = ?`, [name, collectionId]);
  }

  /**
   * Every collection, oldest first, each with how many passages it holds -
   * P4's real multi-list CRUD, for the Manage screen's lists table (P5).
   *
   * `passageCount` is aggregated in SQL (a `LEFT JOIN` + `COUNT`, zero for an
   * empty list) rather than by calling `listPassages` per row, so the table's
   * one request stays one query regardless of how many lists exist.
   *
   * The join condition itself carries `deleted_at IS NULL` (Decision 16, task
   * 0028/P6), not a `WHERE` on the outer query: `deleteCollection` parks a
   * deleted list's soft-deleted passages in another surviving collection, and
   * those must not inflate that collection's shown count - but a `WHERE`
   * would turn this back into an inner join and drop an otherwise-empty
   * collection (one with only soft-deleted rows, or none at all) out of the
   * result entirely, where it should show `passageCount: 0`.
   */
  async listCollections(): Promise<CollectionView[]> {
    const rows = await this.db.query<{ id: number; name: string; passageCount: number }>(
      `SELECT c.id AS id, c.name AS name, COUNT(p.id) AS passageCount
         FROM collection c
         LEFT JOIN passage p ON p.collection_id = c.id AND p.deleted_at IS NULL
        GROUP BY c.id, c.name
        ORDER BY c.id`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, passageCount: r.passageCount }));
  }

  /** Creates a new, empty list. `now` is passed in rather than read here, matching `addPassage`. */
  async createCollection(name: string, now: number): Promise<{ id: number; name: string }> {
    const res = await this.db.run(`INSERT INTO collection (name, created_at) VALUES (?, ?)`, [
      name,
      now,
    ]);
    return { id: Number(res.lastInsertRowid), name };
  }

  /**
   * Deletes a list, soft-deleting its passages the same way `removePassage`
   * does rather than letting them go with it.
   *
   * `passage.collection_id` is still `ON DELETE CASCADE`, and that CASCADE
   * does not know or care about `deleted_at` - a plain `DELETE FROM
   * collection` would hard-delete every passage row pointing at it,
   * soft-deleted or not, which would defeat Decision 16 (task 0028/P6) for a
   * whole-list delete: "re-add into a new list restores progress" would
   * silently stop working the moment the list itself was gone, even though it
   * keeps working for a single `removePassage` from within a surviving list.
   *
   * So before the collection row goes, every passage it owns - including any
   * that were already soft-deleted while this list still existed - is
   * reassigned to another surviving collection (`targetId` below) and
   * soft-deleted at the same time, so the CASCADE that follows has nothing
   * left to touch. If this was the last collection, one is created first
   * (`fallbackName`, mirroring `ensureDefaultCollection` in `db.ts` and its
   * own `createCollection`) purely to hold the orphaned rows until a later
   * `addPassage` revives them elsewhere - it is not made active here; that
   * stays `main.ts`'s job, the same as it always has been for "whether the
   * deleted list was the active one".
   *
   * One edge case: `targetId` can already have its own row for the same
   * `(module_id, start_verse_id, end_verse_id)` - the user had the same
   * reference in both lists independently - and the `passage_range_unique`
   * index (scoped per collection) forbids a second one there. Decision 16
   * only names one target collection for this move, so that duplicate is
   * hard-deleted outright rather than left to block the whole list's
   * deletion; the row already sitting in `targetId` keeps its own history and
   * is what a later `addPassage` revives instead.
   *
   * The whole move-then-delete runs in one transaction: a failure partway
   * through must not leave passages reassigned while the collection row they
   * used to belong to is still there, or vice versa.
   */
  async deleteCollection(collectionId: number, now: number, fallbackName: string): Promise<void> {
    const existing = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM collection WHERE id = ?`,
      [collectionId],
    );
    if (!existing) return;

    await this.db.transaction(async (tx) => {
      // Unfiltered: a passage already soft-deleted in this list has to be
      // carried over too, or its revival key would be lost the moment its
      // holding list disappears.
      const passages = await tx.query<PassageRow>(`SELECT * FROM passage WHERE collection_id = ?`, [
        collectionId,
      ]);

      if (passages.length > 0) {
        const other = await tx.queryOne<{ id: number }>(
          `SELECT id FROM collection WHERE id != ? ORDER BY id LIMIT 1`,
          [collectionId],
        );
        let targetId = other?.id;
        if (targetId === undefined) {
          const created = await tx.run(`INSERT INTO collection (name, created_at) VALUES (?, ?)`, [
            fallbackName,
            now,
          ]);
          targetId = Number(created.lastInsertRowid);
        }

        for (const p of passages) {
          const collision = await tx.queryOne<{ id: number }>(
            `SELECT id FROM passage
              WHERE collection_id = ? AND module_id = ? AND start_verse_id = ? AND end_verse_id = ?`,
            [targetId, p.module_id, p.start_verse_id, p.end_verse_id],
          );
          if (collision) {
            await tx.run(`DELETE FROM passage WHERE id = ?`, [p.id]);
            continue;
          }
          await tx.run(`UPDATE passage SET deleted_at = ?, collection_id = ? WHERE id = ?`, [
            p.deleted_at ?? now,
            targetId,
            p.id,
          ]);
        }
      }

      await tx.run(`DELETE FROM collection WHERE id = ?`, [collectionId]);
    });
  }

  /**
   * The collection every request that does not name one explicitly should
   * act on - `getPlan`, `addPassage`, and so on.
   *
   * Self-healing rather than a bare setting read: if nothing has ever been
   * stored (a fresh install, or an upgrade from before lists were
   * switchable), or if the stored id no longer names a real collection (the
   * active list was deleted out from under it), this falls back to the
   * oldest surviving collection - the same `ORDER BY id LIMIT 1` query
   * `ensureDefaultCollection` (`db.ts`) uses to find the one collection a
   * pre-P4 install already has, so both a fresh install and an upgrade land
   * on the same sane row. Returns `undefined` only when no collection exists
   * at all, which `main.ts#resolveActiveCollectionId` treats as "recreate a
   * default" rather than something this layer should paper over itself.
   */
  async getActiveCollectionId(): Promise<number | undefined> {
    const stored = await this.getSetting(SETTING_ACTIVE_COLLECTION);
    if (stored !== undefined) {
      const id = Number(stored);
      const row = await this.db.queryOne<{ id: number }>(`SELECT id FROM collection WHERE id = ?`, [id]);
      if (row) return id;
    }
    const fallback = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM collection ORDER BY id LIMIT 1`,
    );
    return fallback?.id;
  }

  async setActiveCollectionId(collectionId: number): Promise<void> {
    await this.setSetting(SETTING_ACTIVE_COLLECTION, String(collectionId));
  }

  // -- passages -------------------------------------------------------------

  /** `deleted_at IS NULL` - see Decision 16 (task 0028/P6) - so a soft-deleted passage is invisible here, same as a hard-deleted one always was. */
  async listPassages(collectionId: number): Promise<Passage[]> {
    const rows = await this.db.query<PassageRow>(
      `SELECT * FROM passage WHERE collection_id = ? AND deleted_at IS NULL ORDER BY start_verse_id`,
      [collectionId],
    );
    return rows.map(toPassage);
  }

  /**
   * Every passage in the plan, across every list.
   *
   * Used where P4's Decision 14 says a computation is plan-wide rather than
   * scoped to one list: `refmatch`'s distractor pool and its sibling count
   * (`syncLadders` below, and `main.ts`'s mirrors of the same computation),
   * and Analytics. Never used for the plan view itself, which stays scoped to
   * the active list. `deleted_at IS NULL` for the same reason as
   * `listPassages` - Decision 16 (task 0028/P6).
   */
  async listAllPassages(): Promise<Passage[]> {
    const rows = await this.db.query<PassageRow>(
      `SELECT * FROM passage WHERE deleted_at IS NULL ORDER BY start_verse_id`,
    );
    return rows.map(toPassage);
  }

  /** `listAllPassages().length`, without fetching rows the caller only wants to count. */
  async countAllPassages(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM passage WHERE deleted_at IS NULL`,
    );
    return row ? row.n : 0;
  }

  /**
   * A single passage by id, or `undefined` if it does not exist - or, since
   * Decision 16 (task 0028/P6), if it has been soft-deleted. Every existing
   * caller (`buildContext`, `startSession`, `isPassageWellLearned` in
   * `main.ts`) already treats a miss here as "no longer in your plan", which
   * is exactly right for a soft-deleted row too; the row itself still exists
   * physically, but only `addPassage`'s revive branch and
   * `purgeOldDeletedPassages` look past `deleted_at` to find it.
   */
  async getPassage(id: number): Promise<Passage | undefined> {
    const row = await this.db.queryOne<PassageRow>(
      `SELECT * FROM passage WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row ? toPassage(row) : undefined;
  }

  /**
   * Insert a passage and give it the ladder its shape implies.
   *
   * Two ways this can avoid a fresh `INSERT`, checked in order:
   *
   *  1. This exact range is already active in the target collection - a user
   *     slip, not an error worth a dialog - so the second add simply lands on
   *     the passage they already have (`created: false`, `revived: false`).
   *  2. Decision 16 (task 0028/P6): a soft-deleted row matching this exact
   *     `(module_id, start_verse_id, end_verse_id)` exists in ANY collection
   *     - left behind by `removePassage` or `deleteCollection` - in which
   *     case it is revived in place (`deleted_at` cleared, `collection_id`
   *     moved to the target) rather than starting a new row with a fresh
   *     ladder. Matching across every collection, not just the target one, is
   *     what makes "delete a list, re-add the same passages into a new list"
   *     restore progress. `created` stays `false` for this case too - nothing
   *     new was created - and `revived: true` is the one bit that lets a
   *     future caller tell the two `created: false` cases apart; no caller
   *     needs that distinction yet (`main.ts`'s two callers use `.passage`
   *     and `.created` only), so it is exposed rather than hidden behind a
   *     history-losing guess.
   */
  async addPassage(
    input: Omit<Passage, 'id' | 'answerMode'>,
  ): Promise<{ passage: Passage; created: boolean; revived: boolean }> {
    const existing = await this.db.queryOne<PassageRow>(
      `SELECT * FROM passage
        WHERE collection_id = ? AND module_id = ?
          AND start_verse_id = ? AND end_verse_id = ?
          AND deleted_at IS NULL`,
      [input.collectionId, input.moduleId, input.startVerseId, input.endVerseId],
    );
    if (existing) return { passage: toPassage(existing), created: false, revived: false };

    const revivable = await this.db.queryOne<PassageRow>(
      `SELECT * FROM passage
        WHERE module_id = ? AND start_verse_id = ? AND end_verse_id = ?
          AND deleted_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [input.moduleId, input.startVerseId, input.endVerseId],
    );
    if (revivable) {
      await this.db.run(`UPDATE passage SET deleted_at = NULL, collection_id = ? WHERE id = ?`, [
        input.collectionId,
        revivable.id,
      ]);
      // The revived passage can change what applies to its new list's
      // siblings, exactly like a fresh insert does below.
      await this.syncLadders(input.collectionId);
      const passage = await this.getPassage(revivable.id);
      return { passage: passage as Passage, created: false, revived: true };
    }

    const res = await this.db.run(
      `INSERT INTO passage
         (collection_id, module_id, start_verse_id, end_verse_id, reference, verse_count, added_at, answer_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        input.collectionId,
        input.moduleId,
        input.startVerseId,
        input.endVerseId,
        input.reference,
        input.verseCount,
        input.addedAt,
      ],
    );
    const id = Number(res.lastInsertRowid);

    // Adding a passage can change what applies to its *siblings* too: a lone
    // single verse gains a `refmatch` rung the moment a second passage exists.
    await this.syncLadders(input.collectionId);

    const passage = await this.getPassage(id);
    return { passage: passage as Passage, created: true, revived: false };
  }

  /**
   * Soft-delete a passage: sets `deleted_at` instead of removing the row.
   *
   * This is a deliberate REVERSAL of what used to be this method's own rule -
   * that deleting a passage deletes its history on purpose, so Analytics does
   * not keep counting work on deleted material. Decision 16 (task 0028/P6)
   * overturns that: item 18 asked for a passage's progress to survive being
   * removed and re-added later (even into a different list), which is only
   * possible if the row and its cards/attempts are still there for
   * `addPassage`'s revive branch to find. The Analytics guarantee the old
   * rule protected is instead now made by every read path filtering
   * `deleted_at IS NULL` (`listPassages`, `listAllPassages`,
   * `countAllPassages`, `getPassage`, `analytics`, `dueCount`/`nextDueCard`):
   * a soft-deleted passage disappears from the app exactly as a hard-deleted
   * one always did. `purgeOldDeletedPassages` is what eventually reaches for
   * the real `DELETE`, and cards/attempts only go then, via the same cascade
   * this method used to trigger directly.
   */
  async removePassage(id: number, now: number): Promise<void> {
    const passage = await this.getPassage(id);
    if (!passage) return;
    await this.db.run(`UPDATE passage SET deleted_at = ? WHERE id = ?`, [now, id]);
    await this.syncLadders(passage.collectionId);
  }

  /**
   * Hard-deletes passages that have been soft-deleted for longer than
   * `maxAgeMs` - the automatic purge policy behind Decision 16's soft delete
   * (no manual "delete permanently" escape hatch was designed; this is the
   * only path back to a real `DELETE`). `now` and `maxAgeMs` both travel in
   * rather than being read from the clock or a constant here, matching every
   * other store method that needs "now" (`addPassage`'s `input.addedAt`,
   * `createCollection`'s `now`) - `main.ts` owns the 7-day policy value as a
   * named constant and calls this once per activation.
   *
   * The `DELETE` itself reaches a purged passage's cards and attempts through
   * the ordinary `ON DELETE CASCADE` chain (`card` from `passage`, `attempt`
   * from `card`) - the same cascade `removePassage` used to trigger directly
   * before Decision 16, now deferred until the revival window has passed.
   */
  async purgeOldDeletedPassages(now: number, maxAgeMs: number): Promise<number> {
    const cutoff = now - maxAgeMs;
    const res = await this.db.run(`DELETE FROM passage WHERE deleted_at IS NOT NULL AND deleted_at < ?`, [
      cutoff,
    ]);
    return res.changes;
  }

  async setPassageAnswerMode(passageId: number, mode: AnswerMode | null): Promise<void> {
    await this.db.run(`UPDATE passage SET answer_mode = ? WHERE id = ?`, [mode, passageId]);
  }

  // -- settings ---------------------------------------------------------------

  async getSetting(key: string): Promise<string | undefined> {
    const row = await this.db.queryOne<{ value: string }>(
      `SELECT value FROM setting WHERE key = ?`,
      [key],
    );
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(`INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)`, [key, value]);
  }

  async getDefaultAnswerMode(): Promise<AnswerMode> {
    const value = await this.getSetting(SETTING_DEFAULT_ANSWER_MODE);
    return value === 'fullWord' ? 'fullWord' : DEFAULT_ANSWER_MODE;
  }

  async setDefaultAnswerMode(mode: AnswerMode): Promise<void> {
    await this.setSetting(SETTING_DEFAULT_ANSWER_MODE, mode);
  }

  async getPassageSortOrder(): Promise<PassageSortOrder> {
    const value = await this.getSetting(SETTING_PASSAGE_SORT_ORDER);
    return value === 'need' ? 'need' : DEFAULT_PASSAGE_SORT_ORDER;
  }

  async setPassageSortOrder(order: PassageSortOrder): Promise<void> {
    await this.setSetting(SETTING_PASSAGE_SORT_ORDER, order);
  }

  // -- cards ----------------------------------------------------------------

  async listCards(passageId: number): Promise<Card[]> {
    const rows = await this.db.query<CardRow>(
      `SELECT * FROM card WHERE passage_id = ? ORDER BY id`,
      [passageId],
    );
    return rows.map(toCard);
  }

  async getCard(passageId: number, rung: Rung): Promise<Card | undefined> {
    const row = await this.db.queryOne<CardRow>(
      `SELECT * FROM card WHERE passage_id = ? AND rung = ?`,
      [passageId, rung],
    );
    return row ? toCard(row) : undefined;
  }

  /**
   * Make every passage's card rows match the ladder its shape currently
   * implies.
   *
   * A rung that stops applying is **not deleted**. Removing the second
   * passage from a collection makes `refmatch` meaningless again, but the
   * user's attempts at it were real. The row stays and is reported as
   * inapplicable; it simply stops being offered.
   *
   * Unlike v0, a newly-applicable rung's card is inserted ready to practise
   * immediately (`due_at = NULL`, meaning "never attempted" rather than
   * "locked"): nothing gates it. `now` is no longer needed here because there
   * is no unlocking decision left to make at sync time.
   */
  async syncLadders(collectionId: number): Promise<void> {
    const passages = await this.listPassages(collectionId);
    // Plan-wide, not this collection's own count (P4/Decision 14): a passage
    // that is alone in its own list can still gain `refmatch` once a sibling
    // exists anywhere in the plan, because the distractor pool `refmatch`
    // draws from is every collection's passages, not just the one being
    // synced here. `syncLadders`'s own job - recomputing cards for the
    // passages that actually changed, in the collection that was touched -
    // is otherwise unchanged; only this number is now global. `main.ts`
    // mirrors the same plan-wide count everywhere else `applicableRungs` is
    // called (`buildPlanView`, `startSession`, `isPassageWellLearned`), so
    // that a card this creates is never later reported as inapplicable by a
    // read path that disagreed about the sibling count.
    const siblingCount = await this.countAllPassages();

    for (const passage of passages) {
      const wanted = applicableRungs(passage.verseCount, siblingCount);
      const existing = await this.listCards(passage.id);
      const have = new Set(existing.map((c) => c.rung));

      for (const rung of wanted) {
        if (have.has(rung)) continue;
        await this.db.run(
          `INSERT INTO card (passage_id, rung, state, interval_step, due_at, streak, last_score)
           VALUES (?, ?, 'new', -1, NULL, 0, NULL)`,
          [passage.id, rung],
        );
      }
    }
  }

  /**
   * Apply a scheduling decision to a card.
   *
   * Every finished attempt reaches here now - there is no replay branch that
   * skips it. `card.state` is written for humans reading the database
   * directly; nothing in this extension reads it back (see the note in
   * `db.ts`'s v2 migration).
   */
  async applySchedule(cardId: number, result: ScheduleResult, score: number): Promise<void> {
    await this.db.run(
      `UPDATE card
          SET interval_step = ?, due_at = ?, streak = ?, last_score = ?, state = ?
        WHERE id = ?`,
      [result.intervalStep, result.dueAt, result.streak, score, stateLabelFor(levelFromScore(score)), cardId],
    );
  }

  // -- resume -----------------------------------------------------------------

  async getResume(cardId: number): Promise<ResumeRow | undefined> {
    const row = await this.db.queryOne<ResumeSqlRow>(
      `SELECT * FROM resume_state WHERE card_id = ?`,
      [cardId],
    );
    return row ? toResume(row) : undefined;
  }

  async saveResume(
    cardId: number,
    state: { cursor: number; correctFirst: number; gradedUnits: number },
    now: number,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO resume_state (card_id, cursor, correct_first, graded_units, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         cursor = excluded.cursor,
         correct_first = excluded.correct_first,
         graded_units = excluded.graded_units,
         updated_at = excluded.updated_at`,
      [cardId, state.cursor, state.correctFirst, state.gradedUnits, now],
    );
  }

  async clearResume(cardId: number): Promise<void> {
    await this.db.run(`DELETE FROM resume_state WHERE card_id = ?`, [cardId]);
  }

  // -- attempts -------------------------------------------------------------

  async recordAttempt(a: Omit<AttemptRow, 'id'>): Promise<number> {
    const res = await this.db.run(
      `INSERT INTO attempt (card_id, at, score, correct_first, total_steps, replay, duration_ms)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [a.cardId, a.at, a.score, a.correctFirst, a.totalSteps, a.durationMs],
    );
    return Number(res.lastInsertRowid);
  }

  // -- scheduling queries ---------------------------------------------------

  /**
   * Joined against `passage` and filtered `deleted_at IS NULL` (Decision 16,
   * task 0028/P6): `card` rows are untouched by a soft delete, so without
   * this join a just-removed passage's still-due cards would keep inflating
   * the status bar's count until `purgeOldDeletedPassages` eventually catches
   * up - a soft-deleted passage has to stop being due immediately, the same
   * as a hard-deleted one always did.
   */
  async dueCount(now: number): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM card c
         JOIN passage p ON p.id = c.passage_id
        WHERE c.due_at IS NOT NULL AND c.due_at <= ? AND p.deleted_at IS NULL`,
      [now],
    );
    return row ? row.n : 0;
  }

  /**
   * The next card to practise, across the whole collection.
   *
   * Ordered by due date, then by rung position so that a passage with two
   * rungs due is worked from the bottom up rather than in row order - being
   * asked for first letters before the ordering rung of the same passage
   * would be backwards.
   *
   * Joined against `passage` and filtered `deleted_at IS NULL` for the same
   * reason as `dueCount` (Decision 16, task 0028/P6) - and for an extra
   * reason specific to this query: without the join, a soft-deleted
   * passage's still-due card could be the single row this picks (`LIMIT 1`),
   * and the `getPassage` call below would then return `undefined` for it and
   * make the whole method report "nothing due" even while a real due card
   * exists further down the queue.
   */
  async nextDueCard(now: number): Promise<{ card: Card; passage: Passage } | undefined> {
    const row = await this.db.queryOne<CardRow>(
      `SELECT c.* FROM card c
        JOIN passage p ON p.id = c.passage_id
        WHERE c.due_at IS NOT NULL AND c.due_at <= ? AND p.deleted_at IS NULL
        ORDER BY c.due_at ASC,
                 CASE c.rung
                   WHEN 'ordering' THEN 0
                   WHEN 'refmatch' THEN 0
                   WHEN 'blanks' THEN 1
                   WHEN 'firstletters' THEN 2
                   ELSE 3
                 END ASC
        LIMIT 1`,
      [now],
    );
    if (!row) return undefined;
    const passage = await this.getPassage(row.passage_id);
    if (!passage) return undefined;
    return { card: toCard(row), passage };
  }

  // -- analytics --------------------------------------------------------------

  /**
   * Encouragement-oriented aggregates for the Analytics screen.
   *
   * Deliberately narrower than the old "Progress" screen: "rungs mastered"
   * and "where the effort went" were dropped per the task 0004 review in
   * favour of numbers a user studying scripture actually wants to see move -
   * see `AnalyticsView`.
   *
   * Plan-wide across every list, not scoped to one collection (P4/Decision
   * 14): a user's sense of progress is about their whole memorization
   * practice, not whichever list happens to be active when they open the
   * screen. There is therefore no `collectionId` parameter any more - the
   * one call site (`main.ts`'s `getAnalytics` handler) used to pass the
   * active collection's id and now passes nothing.
   *
   * `listAllPassages()` below already filters `deleted_at IS NULL` (Decision
   * 16, task 0028/P6), so `versesLearned`/`passagesWellLearned` never count a
   * soft-deleted passage's material without this method needing its own
   * filter - the guarantee the old hard-delete rule protected still holds.
   */
  async analytics(now: number): Promise<AnalyticsView> {
    const passages = await this.listAllPassages();

    let versesLearned = 0;
    let passagesWellLearned = 0;
    for (const p of passages) {
      const cards = await this.listCards(p.id);
      const bestLevel = cards.reduce((max, c) => Math.max(max, levelFromScore(c.lastScore)), 0);
      if (bestLevel >= WELL_LEARNED_LEVEL) {
        versesLearned += p.verseCount;
        passagesWellLearned += 1;
      }
    }

    const streakDays = await this.streakDays(now);
    const calendar = await this.calendar(now);
    const recentlyReached = await this.recentlyReached(passages);
    const nextTarget = (Math.floor(versesLearned / 5) + 1) * 5;

    return {
      streakDays,
      versesLearned,
      passagesWellLearned,
      calendar,
      recentlyReached,
      nextMilestone: { versesLearned: nextTarget, toGo: nextTarget - versesLearned },
    };
  }

  /** Consecutive calendar days, ending today, with at least one attempt. */
  private async streakDays(now: number): Promise<number> {
    const rows = await this.db.query<{ day: string }>(
      `SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') AS day FROM attempt`,
    );
    const days = new Set(rows.map((r) => r.day));
    let streak = 0;
    const cursor = new Date(now);
    for (;;) {
      const key = localDateKey(cursor);
      if (!days.has(key)) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  /** The last 35 days, oldest first, marked for whether anything was attempted. */
  private async calendar(now: number): Promise<AnalyticsView['calendar']> {
    const rows = await this.db.query<{ day: string }>(
      `SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') AS day FROM attempt`,
    );
    const practicedDays = new Set(rows.map((r) => r.day));

    const days: AnalyticsView['calendar'] = [];
    const cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - 34);
    for (let i = 0; i < 35; i += 1) {
      days.push({ date: cursor.getTime(), practiced: practicedDays.has(localDateKey(cursor)) });
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  /**
   * The most recent times an attempt first reached "well learned" (level 4 or
   * 5) on a rung, newest first, capped at five.
   *
   * This is a full scan of attempts per card rather than a maintained table:
   * attempt volume for one user's plan is small (see the never-prune rule in
   * `db.ts`) and a milestone is inherently a derived fact, not a written one.
   */
  private async recentlyReached(passages: Passage[]): Promise<Milestone[]> {
    const found: Milestone[] = [];

    for (const passage of passages) {
      const cards = await this.listCards(passage.id);
      for (const card of cards) {
        const attempts = await this.db.query<{ at: number; score: number }>(
          `SELECT at, score FROM attempt WHERE card_id = ? ORDER BY at ASC`,
          [card.id],
        );
        for (const a of attempts) {
          if (levelFromScore(a.score) >= WELL_LEARNED_LEVEL) {
            found.push({
              passageId: passage.id,
              reference: passage.reference,
              rung: card.rung,
              level: levelFromScore(a.score),
              at: a.at,
            });
            break; // Only the first time this card crossed the bar.
          }
        }
      }
    }

    found.sort((a, b) => b.at - a.at);
    return found.slice(0, 5);
  }
}

/** `YYYY-MM-DD` in local time, for grouping attempts by calendar day. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
