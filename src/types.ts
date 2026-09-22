/**
 * Domain types and the panel <-> worker protocol.
 *
 * This file is the contract between the two halves of the extension and is
 * deliberately the first thing written. The worker owns all state, all
 * persistence and all scoring; the panel owns pixels and nothing else. Every
 * message below crosses `api.panels.postMessage` / `BibleExtUI.postToWorker`,
 * which means two hard constraints:
 *
 *   1. Everything here must be structured-cloneable JSON. No class instances,
 *      no functions, no `Date` (epoch milliseconds instead), no `undefined`
 *      inside arrays.
 *   2. Messages are capped at 256 KB each way. A whole book of verse text
 *      would blow that, so the panel asks for one passage's context at a time
 *      and never for a book.
 *
 * ## v1: nothing is locked
 *
 * The original design gated a rung behind two consecutive passes of the one
 * before it (`CardState.locked`, `shouldPromote`). The human review of that
 * design (task 0004) asked for it to be dropped entirely: every activity is
 * always practisable, every attempt counts and reschedules, and a harder
 * activity's level simply carries over into the passage's overall "well
 * learned" status. There is therefore no `locked` state and no `replay`
 * concept any more - see `ladder.ts` for the five-level scale that replaced
 * the four-state one.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * One rung of a mastery ladder.
 *
 * There are two ladders, not one, and they converge after the first rung. Which
 * first rung applies is a property of the *material*, not of the user:
 *
 *   - `ordering`  - a multi-verse passage. "Which verse comes next?"
 *   - `refmatch`  - a single verse among siblings. "Which reference is this?"
 *   - `blanks`    - shared second rung. Type the missing words.
 *   - `firstletters` - shared third rung. Every word is a blank.
 *
 * Reordering a single verse is meaningless and matching a reference needs
 * distractors, so a lone single verse in a collection can do neither and
 * starts at `blanks`. That edge case is why `firstRungFor` exists rather than
 * a constant.
 */
export type Rung = 'ordering' | 'refmatch' | 'blanks' | 'firstletters';

/** Every rung in ladder order. `blanks` and `firstletters` are shared. */
export const RUNG_ORDER: readonly Rung[] = ['ordering', 'refmatch', 'blanks', 'firstletters'];

/**
 * How a hidden word is answered - a setting, not a property of the exercise.
 *
 * `firstLetter` (the default) asks for one letter per hidden word and reveals
 * the whole word the moment it is right; `fullWord` asks for the whole word,
 * spelled out, and is graded leniently on punctuation and case but strictly on
 * letters. It applies identically to `blanks` and `firstletters` - the two
 * activities differ only in *how many* words are hidden, never in how a hidden
 * word is answered.
 */
export type AnswerMode = 'firstLetter' | 'fullWord';

/** A named group of passages. v0 ships exactly one, called "My plan". */
export interface Collection {
  id: number;
  name: string;
  createdAt: number;
}

/**
 * One collection as the Manage screen's lists table needs it (P4's store
 * layer; P5 renders the table itself).
 *
 * `passageCount` is carried here rather than left for the panel to derive
 * from `plan.passages`, because the lists table shows every list - including
 * ones that are not the active list, and so have no `PassageView[]` of their
 * own on hand.
 */
export interface CollectionView {
  id: number;
  name: string;
  passageCount: number;
}

/**
 * A passage under memorisation: an inclusive verse-id range in one module.
 *
 * `moduleId` is stored because the same reference in two translations is two
 * different memorisation tasks - the words differ, so the cards differ.
 */
export interface Passage {
  id: number;
  collectionId: number;
  moduleId: string;
  startVerseId: number;
  endVerseId: number;
  /** Display reference, e.g. "John 3:16-18". Resolved once at add time. */
  reference: string;
  /** Verse count, cached so the plan list does not need the text. */
  verseCount: number;
  addedAt: number;
  /** This passage's own answer-mode override, or `null` to use the default. */
  answerMode: AnswerMode | null;
}

/** A schedulable unit: one passage at one rung. Never locked; always practisable. */
export interface Card {
  id: number;
  passageId: number;
  rung: Rung;
  /** Index into the interval ladder. -1 while the card has never passed. */
  intervalStep: number;
  /** Epoch ms. `null` until the first attempt sets a schedule. */
  dueAt: number | null;
  /** Consecutive passing attempts. Reset to 0 by a failure. */
  streak: number;
  /** Score of the most recent attempt, 0..1. `null` if never tried. */
  lastScore: number | null;
}

/**
 * One recorded attempt. These rows are never pruned.
 *
 * That is a stated rule rather than an accident: the user asked to keep the
 * data even where the UI does not surface it, so that a statistic they decide
 * they want later can be computed over real history instead of starting from
 * the day it was added.
 */
export interface AttemptRow {
  id: number;
  cardId: number;
  at: number;
  /** 0..1. Correct-first-attempts over steps. */
  score: number;
  correctFirst: number;
  totalSteps: number;
  /**
   * Wall-clock length of the session that produced this row, in milliseconds.
   * `null` for older rows recorded before this column existed. Not shown
   * anywhere in the UI yet - stored now so a future Analytics screen does not
   * have to start counting from the day someone asks for it.
   */
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Views - what the panel actually renders
// ---------------------------------------------------------------------------

/** How far along a paused activity is, so "Resume" can say where it left off. */
export interface ResumeState {
  /** Verses (or ordering steps) already completed. */
  stepsDone: number;
  totalSteps: number;
}

export interface RungView {
  rung: Rung;
  /** 0 (never tried) to 5 (basically perfect). See `ladder.ts#levelFromScore`. */
  level: number;
  dueAt: number | null;
  streak: number;
  lastScore: number | null;
  /** False when this rung does not apply to this passage at all. */
  applicable: boolean;
  /** Set when this activity was left mid-way and can be resumed. */
  resume: ResumeState | null;
}

/** A passage plus its ladder, as the plan list and passage screen need it. */
export interface PassageView {
  passage: Passage;
  rungs: RungView[];
  /** Number of applicable rungs due now. Drives the badge on the plan row. */
  dueCount: number;
  /**
   * The highest level reached by any applicable rung.
   *
   * A level reached on a harder activity counts for the whole passage without
   * implying the easier ones were themselves practised to that level - see the
   * task 0004 review, point 10. This is the single number that answers "is
   * this passage well learned?" (`wellLearned`, at 4 or above).
   */
  bestLevel: number;
  wellLearned: boolean;
}

/** How the passage list orders its rows - see `format.ts#sortPassagesByNeed`. */
export type PassageSortOrder = 'bible' | 'need';

export interface PlanView {
  collectionId: number;
  collectionName: string;
  passages: PassageView[];
  totalDue: number;
  /** The panel's current answer-mode default, so "Start practicing" etc. need no second fetch. */
  defaultAnswerMode: AnswerMode;
  /** The passage list's current sort choice, so the list needs no second fetch either. */
  sortOrder: PassageSortOrder;
}

/** The user's answer-mode preference, and how it applies. */
export interface SettingsView {
  defaultAnswerMode: AnswerMode;
}

/** One calendar day on the Analytics practice calendar. */
export interface CalendarDay {
  /** Epoch ms for local midnight that day. */
  date: number;
  practiced: boolean;
}

/** One recent level-up, for "Recently reached". */
export interface Milestone {
  passageId: number;
  reference: string;
  rung: Rung;
  level: number;
  at: number;
}

/** Aggregate, encouragement-oriented counts for the Analytics screen. */
export interface AnalyticsView {
  /** Consecutive days, ending today, with at least one attempt. */
  streakDays: number;
  /** Verses in passages that are "well learned" (`bestLevel >= 4`). */
  versesLearned: number;
  passagesWellLearned: number;
  /** The last 35 days, oldest first. */
  calendar: CalendarDay[];
  /** Most recent "reached level 4 or 5" events, newest first. */
  recentlyReached: Milestone[];
  /** The next round number of verses learned, and how far off it is. */
  nextMilestone: { versesLearned: number; toGo: number };
}

// ---------------------------------------------------------------------------
// Verse text and context
// ---------------------------------------------------------------------------

/**
 * One poetic line inside a verse, mirroring `@bible/core`'s `PoetryLine`.
 *
 * Carried through because the layout has to honour indentation, and because a
 * verse is routinely several lines at different levels - Psalm 1:1 is three.
 * `level` 1 is the outermost.
 */
export interface Line {
  /** First word this line covers. 0-based index into `VerseText.words`. */
  start: number;
  /**
   * Last word this line covers - 0-based and **INCLUSIVE**, matching
   * `PoetryLine` in `@bible/core`.
   *
   * Stated rather than inherited because the cost of guessing wrong is
   * invisible: treating it as exclusive silently drops the last word of every
   * poetic line, which looks like a plausible line break rather than a bug.
   * A slice is `words.slice(start, end + 1)`.
   */
  end: number;
  /** 1 is the outermost indent, 3 the deepest. */
  level: 1 | 2 | 3;
}

/** A verse as the panel renders it. */
export interface VerseText {
  verseId: number;
  /** Chapter:verse, for the margin. */
  label: string;
  /** Words, already split. The panel never re-tokenises - scoring depends on
   *  the worker and the panel agreeing exactly on word boundaries. */
  words: string[];
  /** Poetic lines, or `null` for prose. */
  lines: Line[] | null;
  /** A psalm superscription attached to this verse, if any. */
  psalmTitle: string | null;
  /** True when this verse starts a new paragraph. */
  paragraphStart: boolean;
}

/**
 * A passage plus the verses around it.
 *
 * Context is rendered as real, readable text with the working verse
 * highlighted - not blurred and not reduced to shapes. The one exception is
 * enforced here rather than in the panel: during an exercise the worker
 * withholds the verses *after* the working point, because for the ordering
 * picker and any recite-from-the-start step those verses are the answer.
 */
export interface PassageContext {
  passageId: number;
  reference: string;
  /** Verses before the passage. May be empty at a book boundary. */
  before: VerseText[];
  /** The passage itself. */
  verses: VerseText[];
  /** Verses after the passage. Empty while an exercise is in progress. */
  after: VerseText[];
}

// ---------------------------------------------------------------------------
// Exercise steps
// ---------------------------------------------------------------------------

/**
 * One candidate in the next-verse picker.
 *
 * `preview` is about 25 words or three lines, whichever comes first: the user
 * asked to see a good portion of the verse rather than a bare reference, since
 * recognising the opening words is the skill being trained.
 */
export interface PickerCandidate {
  verseId: number;
  preview: string;
  truncated: boolean;
}

/** "Which verse comes next?" - the first rung for a multi-verse passage. */
export interface OrderingStep {
  kind: 'ordering';
  /** Verses already placed, in order, shown as real text above the choice. */
  placed: VerseText[];
  candidates: PickerCandidate[];
  /** 1-based, for "step 3 of 7". */
  stepNumber: number;
  totalSteps: number;
}

/**
 * "Which reference is this?" - matches a passage's own text (a short
 * preview) to its own reference, as one passage-level unit. Applies to any
 * passage, whether it spans one verse or many, once there is at least one
 * other passage in the plan to distract with - see `ladder.ts`.
 */
export interface RefMatchStep {
  kind: 'refmatch';
  verse: VerseText;
  candidates: { passageId: number; reference: string }[];
  stepNumber: number;
  totalSteps: number;
}

/**
 * Type the missing words.
 *
 * `blankIndices` are indices into `verse.words`. The panel renders an input
 * sized to the hidden word's measured width so that revealing it does not
 * repaginate the passage; overtyping grows the line, never the page.
 */
export interface BlanksStep {
  kind: 'blanks';
  verse: VerseText;
  /**
   * Indices into `verse.words`, **guaranteed ascending**.
   *
   * The order is part of the contract, not an accident of how blanks are
   * chosen. The panel renders inputs in word order and submits them as a
   * positional array, so `typed[k]` is matched against `blankIndices[k]`.
   * `Session.prepareStep` sorts before sending so this holds no matter what
   * `selectBlanks` returns.
   */
  blankIndices: number[];
  /** How the panel should collect the answer for each hidden word. */
  answerMode: AnswerMode;
  stepNumber: number;
  totalSteps: number;
}

/**
 * Every word is hidden - the closest thing to unaided recitation.
 *
 * There are no reveal tiers: a correct answer (a letter, in `firstLetter`
 * mode; the whole word, in `fullWord` mode) reveals the whole word, always.
 */
export interface FirstLettersStep {
  kind: 'firstletters';
  verse: VerseText;
  answerMode: AnswerMode;
  stepNumber: number;
  totalSteps: number;
}

export type Step = OrderingStep | RefMatchStep | BlanksStep | FirstLettersStep;

/**
 * The verdict on one submitted step.
 *
 * `blocking` is what the picker needs: a wrong choice is reported, marked so
 * the user can see which one they clicked, and the same step is served again
 * until it is right. The mark is transient - it exists to say "not that one",
 * not to keep a tally on screen.
 */
export interface StepResult {
  correct: boolean;
  /**
   * What the user got wrong on this submission. **The meaning depends on the
   * step kind that asked**, and both are small integers, so a consumer must
   * key off the step rather than guess:
   *
   *   - `ordering`      - the verse id that was picked
   *   - `refmatch`      - the passage id that was picked
   *   - `blanks`        - indices into `VerseText.words` (a subset of
   *                       `BlanksStep.blankIndices`, in the same space)
   *   - `firstletters`  - indices into `VerseText.words`
   *
   * Always the current submission only. It does not accumulate across the
   * retries of a blocked step: the mark exists to say "not that one", not to
   * keep a tally on screen.
   */
  wrong: number[];
  /** True when the step must be retried before the session can advance. */
  blocking: boolean;
  /** The correct answer, revealed once the step is finally resolved. */
  reveal?: { words?: string[]; verseId?: number };
}

/** A session in progress. The worker owns it; the panel holds only the id. */
export interface SessionView {
  sessionId: string;
  passageId: number;
  rung: Rung;
  step: Step | null;
  /** Running tally, shown in the session header. */
  correctFirst: number;
  stepsTaken: number;
}

export interface SessionSummary {
  passageId: number;
  rung: Rung;
  score: number;
  correctFirst: number;
  totalSteps: number;
  nextDueAt: number | null;
  /** This activity's level (0-5) after this attempt. */
  level: number;
  /** Whether the passage as a whole is now "well learned" (see `bestLevel`). */
  passageWellLearned: boolean;
}

// ---------------------------------------------------------------------------
// Panel -> worker requests
// ---------------------------------------------------------------------------

export type PanelRequest =
  | { type: 'getPlan' }
  | { type: 'getAnalytics' }
  | { type: 'getSettings' }
  | { type: 'setDefaultAnswerMode'; mode: AnswerMode }
  | { type: 'setPassageSortOrder'; order: PassageSortOrder }
  | { type: 'setPassageAnswerMode'; passageId: number; mode: AnswerMode | null }
  /**
   * Renames the one collection v0 ships (Decision 14). `collectionId` is
   * carried rather than assumed, mirroring every other request that names
   * the row it acts on, even though there is only ever one today - P4's real
   * multi-list data model will need it distinguished from others anyway.
   */
  | { type: 'renameCollection'; collectionId: number; name: string }
  /** The lists table's own data (P4/P5) - every collection, not just the active one. */
  | { type: 'getCollections' }
  | { type: 'createCollection'; name: string }
  | { type: 'deleteCollection'; collectionId: number }
  /**
   * Switches which collection `getPlan`, `addPassage` etc. act on. Persisted
   * (`MemoryStore#setActiveCollectionId`), so it survives a panel reload and a
   * worker restart, not just this session.
   */
  | { type: 'setActiveCollection'; collectionId: number }
  | { type: 'getContext'; passageId: number }
  | { type: 'addPassage'; reference: string }
  | { type: 'removePassage'; passageId: number }
  | { type: 'startSession'; passageId: number; rung?: Rung; restart?: boolean }
  | { type: 'submitStep'; sessionId: string; answer: StepAnswer }
  | { type: 'endSession'; sessionId: string }
  | { type: 'navigateTo'; verseId: number };

/** What the user did, keyed to the step kind that asked. */
export type StepAnswer =
  | { kind: 'ordering'; verseId: number }
  | { kind: 'refmatch'; passageId: number }
  | { kind: 'blanks'; words: string[] }
  | { kind: 'firstletters'; words: string[] };

/**
 * Every reply is discriminated by `ok` rather than by throwing across the
 * boundary. An exception in `api.panels.onMessage` reaches the panel as an
 * opaque RPC failure with no useful message, so failures that the user should
 * see - "that reference does not parse" - travel as data.
 */
export type PanelReply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface RequestMap {
  getPlan: PlanView;
  getAnalytics: AnalyticsView;
  getSettings: SettingsView;
  setDefaultAnswerMode: Record<string, never>;
  setPassageSortOrder: Record<string, never>;
  setPassageAnswerMode: Record<string, never>;
  renameCollection: Record<string, never>;
  getCollections: CollectionView[];
  createCollection: { id: number; name: string };
  deleteCollection: Record<string, never>;
  setActiveCollection: Record<string, never>;
  getContext: PassageContext;
  addPassage: { passage: Passage };
  removePassage: Record<string, never>;
  startSession: SessionView;
  submitStep: { result: StepResult; session: SessionView; summary: SessionSummary | null };
  endSession: { summary: SessionSummary | null };
  navigateTo: Record<string, never>;
}

// ---------------------------------------------------------------------------
// Worker -> panel pushes
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget notifications. A panel that is not open simply is not
 * there, so nothing here may carry state the panel would otherwise miss - the
 * panel re-reads on open.
 */
export type WorkerPush =
  | { type: 'planChanged' }
  | { type: 'dueCountChanged'; count: number }
  /** The host's active verse moved. Used to prefill the add-passage field. */
  | { type: 'activeVerse'; verseId: number; reference: string };
