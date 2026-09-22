/**
 * The exercise session: what the user is doing right now.
 *
 * Sessions live in worker memory and are never persisted wholesale. That is
 * deliberate: a half-finished session is not a fact about the user's memory
 * of a passage, it is a fact about a window they had open. What survives a
 * restart is the *resume point* - `cursor`, and the running tally - written to
 * the `resume_state` table after each verse (see `main.ts#submitStep`), not
 * every keystroke. Reconstructing a session from that point does not need to
 * reproduce the exact randomness of steps already graded, only the position
 * and the tally, so a resumed session simply seeds a fresh RNG for whatever
 * comes next.
 *
 * The worker owning the session (rather than the panel) is what makes the
 * pop-out window work at all: a popped-out panel is a fresh document with a
 * fresh iframe, so any state the panel held would be gone. The worker is a
 * long-lived process, so the session survives the panel being moved, closed
 * and reopened.
 *
 * ## Scoring
 *
 * One number, everywhere: **correct first attempts over graded units**. The
 * unit differs by rung - a pick, a blank, a word - but the meaning does not,
 * and a user can be told it in one sentence. Retries after a wrong answer are
 * still recorded but can never earn back the credit, which is what makes a
 * blocking picker honest: you always finish, and finishing is not the same as
 * being right.
 *
 * ## v1: every attempt counts
 *
 * There is no `replay` flag any more. Nothing is locked, so there is no
 * distinction left to draw between "the scheduled attempt" and "practising
 * ahead" - see the task 0004 review, point 4. Every finished session reaches
 * `main.ts#finishSession` and reschedules its card.
 */

import type {
  AnswerMode,
  PickerCandidate,
  Rung,
  SessionView,
  Step,
  StepAnswer,
  StepResult,
  VerseText,
} from './types';
import { buildCandidates } from './exercises/ordering';
import { selectBlanks, gradeBlanks } from './exercises/blanks';
import { gradeFirstLetters } from './exercises/firstLetters';

/** How many options a picker offers, including the correct one. */
const PICKER_CHOICES = 4;

/**
 * How many of the next unplaced verses the ordering picker draws its
 * candidates from.
 *
 * A window wider than `PICKER_CHOICES` so the pool the distractors are drawn
 * from is not always exactly the set shown: with the window equal to the
 * choice count, every unplaced verse had to appear (there was nothing else to
 * pick from), and the correct verse's position - shuffled or not - was the
 * only thing that varied. That degenerates into a fixed A/B/C/D cycle a user
 * can learn without ever reading the text. Six gives room to leave a verse
 * out entirely so which four appear is itself unpredictable, while staying
 * close enough that a distractor is still a real neighbour of the passage
 * (see `ordering.ts`'s own note on why distractors never come from outside
 * it).
 */
const ORDERING_WINDOW = 6;

/**
 * Fraction of words blanked.
 *
 * Fixed for v0 rather than adaptive. An adaptive difficulty that moves with
 * performance is easy to write and very hard to evaluate - the user cannot
 * tell whether a session felt harder because they were worse or because the
 * software decided so. A constant is legible, and the interval ladder already
 * supplies the escalation.
 */
const BLANK_DIFFICULTY = 0.3;

interface StepState {
  /** Whether the current step has already been answered wrongly once. */
  spoiled: boolean;
}

/** Where a resumed session picks back up. See the file header. */
export interface SessionResume {
  /** Verse index (or, for `ordering`, the number of verses already placed). */
  cursor: number;
  correctFirstUnits: number;
  gradedUnits: number;
}

export interface SessionOpts {
  sessionId: string;
  passageId: number;
  cardId: number;
  rung: Rung;
  verses: VerseText[];
  /** Sibling references, for `refmatch` distractors. */
  siblings: { passageId: number; reference: string }[];
  /** This passage's own id/reference, the correct answer for `refmatch`. */
  self: { passageId: number; reference: string };
  /** How hidden words in `blanks` / `firstletters` are answered. */
  answerMode: AnswerMode;
  rng: () => number;
  /** Continues a previously paused activity. Omit to start from the top. */
  resume?: SessionResume;
}

export class Session {
  readonly sessionId: string;
  readonly passageId: number;
  readonly cardId: number;
  readonly rung: Rung;
  readonly answerMode: AnswerMode;

  private readonly verses: VerseText[];
  private readonly siblings: { passageId: number; reference: string }[];
  private readonly self: { passageId: number; reference: string };
  private readonly rng: () => number;

  /** Index of the verse currently being worked. */
  private cursor = 0;
  private readonly stepState: StepState = { spoiled: false };

  /** Blanks chosen for the current verse, held so a retry asks the same ones. */
  private currentBlanks: number[] = [];
  private currentCandidates: PickerCandidate[] = [];
  private currentRefCandidates: { passageId: number; reference: string }[] = [];

  private correctFirstUnits = 0;
  private gradedUnits = 0;
  private finished = false;

  constructor(opts: SessionOpts) {
    this.sessionId = opts.sessionId;
    this.passageId = opts.passageId;
    this.cardId = opts.cardId;
    this.rung = opts.rung;
    this.verses = opts.verses;
    this.siblings = opts.siblings;
    this.self = opts.self;
    this.answerMode = opts.answerMode;
    this.rng = opts.rng;

    if (opts.resume && opts.resume.cursor > 0 && opts.resume.cursor < this.verseSteps()) {
      this.cursor = opts.resume.cursor;
      this.correctFirstUnits = opts.resume.correctFirstUnits;
      this.gradedUnits = opts.resume.gradedUnits;
    }
    this.prepareStep();
  }

  /** How many verses (or ordering placements) this rung walks through. */
  private verseSteps(): number {
    return this.rung === 'ordering' ? Math.max(1, this.verses.length) : this.verses.length;
  }

  // -- presentation ---------------------------------------------------------

  /**
   * How many steps the user will be asked to do, in presentation units.
   *
   * Ordering is `n`: every verse in the passage is picked, including the
   * first. An earlier version gave the first verse away for free ("you
   * cannot be asked what comes after nothing"), but that meant the very first
   * choice of every round was not a choice at all - see `prepareStep`.
   */
  get totalSteps(): number {
    switch (this.rung) {
      case 'ordering':
        return Math.max(1, this.verses.length);
      case 'refmatch':
        return 1;
      default:
        return this.verses.length;
    }
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Correct-first-attempts over graded units, 0..1. */
  get score(): number {
    if (this.gradedUnits === 0) return 0;
    return this.correctFirstUnits / this.gradedUnits;
  }

  get correctFirst(): number {
    return this.correctFirstUnits;
  }

  get gradedTotal(): number {
    return this.gradedUnits;
  }

  /** How far through the session this is, for persisting a resume point. */
  get cursorIndex(): number {
    return this.cursor;
  }

  view(): SessionView {
    return {
      sessionId: this.sessionId,
      passageId: this.passageId,
      rung: this.rung,
      step: this.finished ? null : this.currentStep(),
      correctFirst: this.correctFirstUnits,
      stepsTaken: this.gradedUnits,
    };
  }

  // -- step construction ----------------------------------------------------

  /**
   * Choose the material for the step at `cursor`.
   *
   * Called once per step, not per render: a retry must ask exactly the same
   * question. Re-selecting blanks or reshuffling candidates on a retry would
   * let a user reroll their way past a word they could not remember.
   */
  private prepareStep(): void {
    this.stepState.spoiled = false;
    if (this.finished) return;

    if (this.rung === 'ordering') {
      // The verse to find is the one after everything already placed - which,
      // with `cursor` counting verses placed so far, is `verses[cursor]`.
      // Nothing is given for free any more: at `cursor === 0` this asks which
      // verse comes FIRST, exactly like every later step asks which comes
      // next (see `currentStep`'s prompt).
      const remaining = this.verses.slice(this.cursor);
      const correct = remaining[0];
      if (!correct) {
        this.finished = true;
        return;
      }
      // The candidate pool is a WINDOW of the next `ORDERING_WINDOW` unplaced
      // verses, not every verse left in the passage. Two reasons: a distractor
      // from far ahead in a long passage is rejected on unfamiliarity alone
      // and teaches nothing (same logic as never drawing one from outside the
      // passage), and a pool wider than what is shown means the four verses
      // offered are themselves a random draw, not a deterministic "whatever is
      // left". See `ORDERING_WINDOW`'s own note.
      const pool = remaining.slice(0, ORDERING_WINDOW);
      this.currentCandidates = buildCandidates(pool, correct.verseId, PICKER_CHOICES, this.rng);
      return;
    }

    if (this.rung === 'refmatch') {
      // Shuffled HERE, once, and not in `currentStep()`. Building the list on
      // each render consumed the session's stateful RNG every time, so the
      // options reordered on every `view()` - including the re-serve after a
      // wrong pick, which made the user's "not that one" mark point at a
      // different reference than the one they had clicked, and let them reroll
      // positions by retrying.
      this.currentRefCandidates = [this.self, ...this.siblings]
        .slice(0, PICKER_CHOICES)
        .map((s) => ({ passageId: s.passageId, reference: s.reference }));
      shuffle(this.currentRefCandidates, this.rng);
      return;
    }

    if (this.rung === 'blanks') {
      const verse = this.verses[this.cursor];
      if (!verse) {
        this.finished = true;
        return;
      }
      // Sorted here, at the boundary, because `BlanksStep.blankIndices` is
      // documented as ascending and the panel relies on it: it renders inputs
      // in word order and submits them positionally, so an unsorted list would
      // grade every answer against the wrong blank. `selectBlanks` happens to
      // sort today; this makes the guarantee independent of that.
      this.currentBlanks = [...selectBlanks(verse, BLANK_DIFFICULTY, this.rng)].sort(
        (a, b) => a - b,
      );
    }
  }

  private currentStep(): Step {
    switch (this.rung) {
      case 'ordering': {
        return {
          kind: 'ordering',
          placed: this.verses.slice(0, this.cursor),
          candidates: this.currentCandidates,
          stepNumber: this.cursor + 1,
          totalSteps: this.totalSteps,
        };
      }
      case 'refmatch': {
        // The verse is shown; the user picks its reference. Distractors are
        // other passages in the plan, which is what makes this an exercise
        // rather than a formality - and why a lone passage skips this rung.
        // The list was built and shuffled once in `prepareStep`; rendering must
        // not disturb it.
        return {
          kind: 'refmatch',
          verse: this.verses[0] as VerseText,
          candidates: this.currentRefCandidates,
          stepNumber: 1,
          totalSteps: 1,
        };
      }
      case 'blanks': {
        return {
          kind: 'blanks',
          verse: this.verses[this.cursor] as VerseText,
          blankIndices: this.currentBlanks,
          answerMode: this.answerMode,
          stepNumber: this.cursor + 1,
          totalSteps: this.totalSteps,
        };
      }
      case 'firstletters': {
        return {
          kind: 'firstletters',
          verse: this.verses[this.cursor] as VerseText,
          answerMode: this.answerMode,
          stepNumber: this.cursor + 1,
          totalSteps: this.totalSteps,
        };
      }
    }
  }

  // -- grading --------------------------------------------------------------

  /**
   * Grade one submission.
   *
   * The pickers block: a wrong answer is reported and the same step is served
   * again until it is right. The wrong choice comes back in `wrong` so the
   * panel can mark it, but the mark is transient by design - it says "not that
   * one", it does not keep a tally on screen. The credit, however, is already
   * gone: `spoiled` makes sure a step can only earn a point once.
   */
  submit(answer: StepAnswer): StepResult {
    if (this.finished) {
      return { correct: false, wrong: [], blocking: false };
    }

    switch (this.rung) {
      case 'ordering':
        return this.submitOrdering(answer);
      case 'refmatch':
        return this.submitRefMatch(answer);
      case 'blanks':
        return this.submitBlanks(answer);
      case 'firstletters':
        return this.submitFirstLetters(answer);
    }
  }

  private submitOrdering(answer: StepAnswer): StepResult {
    if (answer.kind !== 'ordering') return mismatch();
    const expected = this.verses[this.cursor];
    if (!expected) return mismatch();

    if (answer.verseId !== expected.verseId) {
      this.spoil();
      return { correct: false, wrong: [answer.verseId], blocking: true };
    }

    this.creditAndAdvanceUnit();
    this.cursor++;
    if (this.cursor >= this.verses.length) this.finished = true;
    this.prepareStep();
    return {
      correct: true,
      wrong: [],
      blocking: false,
      reveal: { verseId: expected.verseId },
    };
  }

  private submitRefMatch(answer: StepAnswer): StepResult {
    if (answer.kind !== 'refmatch') return mismatch();

    if (answer.passageId !== this.self.passageId) {
      this.spoil();
      return { correct: false, wrong: [answer.passageId], blocking: true };
    }

    this.creditAndAdvanceUnit();
    this.finished = true;
    return { correct: true, wrong: [], blocking: false };
  }

  /**
   * Blanks and first letters are graded per word and do NOT block.
   *
   * The user submits, sees which words were missed in red with a "missed"
   * marker beside them, and moves on. Blocking here would mean sitting on a
   * word you genuinely cannot recall with no way forward, which is a worse
   * experience than being told and shown the answer.
   */
  private submitBlanks(answer: StepAnswer): StepResult {
    if (answer.kind !== 'blanks') return mismatch();
    const verse = this.verses[this.cursor];
    if (!verse) return mismatch();

    const result = gradeBlanks(verse, this.currentBlanks, answer.words);
    this.creditUnits(this.currentBlanks.length, this.currentBlanks.length - result.wrong.length);
    this.advanceVerse();
    return {
      ...result,
      blocking: false,
      reveal: { words: this.currentBlanks.map((i) => verse.words[i] as string) },
    };
  }

  private submitFirstLetters(answer: StepAnswer): StepResult {
    if (answer.kind !== 'firstletters') return mismatch();
    const verse = this.verses[this.cursor];
    if (!verse) return mismatch();

    const result = gradeFirstLetters(verse, answer.words);
    this.creditUnits(verse.words.length, verse.words.length - result.wrong.length);
    this.advanceVerse();
    return { ...result, blocking: false, reveal: { words: verse.words } };
  }

  // -- bookkeeping ----------------------------------------------------------

  /** Mark the current step as no longer eligible for first-attempt credit. */
  private spoil(): void {
    if (!this.stepState.spoiled) {
      this.stepState.spoiled = true;
      // The unit is counted now, unscored. Counting it only on the eventual
      // success would make a blocking step that took five guesses score the
      // same as one answered immediately.
      this.gradedUnits++;
    }
  }

  private creditAndAdvanceUnit(): void {
    if (this.stepState.spoiled) return; // already counted, credit forfeited
    this.gradedUnits++;
    this.correctFirstUnits++;
  }

  private creditUnits(total: number, correct: number): void {
    this.gradedUnits += total;
    this.correctFirstUnits += correct;
  }

  private advanceVerse(): void {
    this.cursor++;
    if (this.cursor >= this.verses.length) {
      this.finished = true;
      return;
    }
    this.prepareStep();
  }
}

/**
 * A step answer whose kind does not match the step that was asked.
 *
 * Only reachable if the panel and worker disagree about session position -
 * a stale reply after the user restarted, say. Reported as an ordinary wrong
 * answer rather than thrown: an exception here would surface in the panel as
 * an opaque RPC failure and lose the session.
 */
function mismatch(): StepResult {
  return { correct: false, wrong: [], blocking: true };
}

/** Fisher-Yates, using the injected RNG so sessions are reproducible in test. */
function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
}

/** Ids are opaque to the panel; a counter is enough and needs no crypto. */
let sessionCounter = 0;
export function nextSessionId(): string {
  sessionCounter += 1;
  return `s${sessionCounter}`;
}
