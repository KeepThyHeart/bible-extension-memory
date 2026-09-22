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

  // -- passages -------------------------------------------------------------

  async listPassages(collectionId: number): Promise<Passage[]> {
    const rows = await this.db.query<PassageRow>(
      `SELECT * FROM passage WHERE collection_id = ? ORDER BY start_verse_id`,
      [collectionId],
    );
    return rows.map(toPassage);
  }

  async getPassage(id: number): Promise<Passage | undefined> {
    const row = await this.db.queryOne<PassageRow>(`SELECT * FROM passage WHERE id = ?`, [id]);
    return row ? toPassage(row) : undefined;
  }

  /**
   * Insert a passage and give it the ladder its shape implies.
   *
   * Returns the existing row if this exact range is already in the collection
   * rather than throwing on the unique index: adding a passage twice is a
   * user slip, not an error worth a dialog, and the second add should simply
   * land on the passage they already have.
   */
  async addPassage(
    input: Omit<Passage, 'id' | 'answerMode'>,
  ): Promise<{ passage: Passage; created: boolean }> {
    const existing = await this.db.queryOne<PassageRow>(
      `SELECT * FROM passage
        WHERE collection_id = ? AND module_id = ?
          AND start_verse_id = ? AND end_verse_id = ?`,
      [input.collectionId, input.moduleId, input.startVerseId, input.endVerseId],
    );
    if (existing) return { passage: toPassage(existing), created: false };

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
    return { passage: passage as Passage, created: true };
  }

  /**
   * Delete a passage and everything hanging off it.
   *
   * The cascade takes its cards and their attempts. That is the one place the
   * never-prune rule yields: keeping the attempt history of a passage the user
   * has explicitly removed would mean their "delete" did not delete, and the
   * Analytics screen would keep counting work against material that is gone.
   */
  async removePassage(id: number): Promise<void> {
    const passage = await this.getPassage(id);
    if (!passage) return;
    await this.db.run(`DELETE FROM passage WHERE id = ?`, [id]);
    await this.syncLadders(passage.collectionId);
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
    const siblingCount = passages.length;

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

  async dueCount(now: number): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM card WHERE due_at IS NOT NULL AND due_at <= ?`,
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
   */
  async nextDueCard(now: number): Promise<{ card: Card; passage: Passage } | undefined> {
    const row = await this.db.queryOne<CardRow>(
      `SELECT c.* FROM card c
        WHERE c.due_at IS NOT NULL AND c.due_at <= ?
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
   */
  async analytics(collectionId: number, now: number): Promise<AnalyticsView> {
    const passages = await this.listPassages(collectionId);

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
