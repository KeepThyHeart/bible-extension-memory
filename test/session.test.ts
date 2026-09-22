/**
 * Session tests - the exercise the user is actually doing.
 *
 * The fixtures are real KJV text (Psalm 23:1-4, John 3:16) rather than
 * `['a','b','c']`, for the same reason `exercises.test.ts` gives: every bug
 * this layer can have is a bug about real text. `shepherd;` and `pastures:`
 * carry punctuation welded to the word, `name's` carries a possessive, the
 * verses are poetry at two indent levels, and a synthetic fixture passes
 * happily while all of that is broken.
 *
 * The centre of gravity here is the blocking picker. It is the only place in
 * the extension where "the user got it right" and "the user gets the credit"
 * come apart, and getting that wrong in either direction is bad in a way the
 * user would feel:
 *
 *   - if a retry could re-roll the step, a user could click through until an
 *     easier set of candidates appeared and never face the verse they cannot
 *     recall;
 *   - if a retry could still earn credit, a seven-verse ordering answered by
 *     brute force would score identically to one recited from memory, and
 *     every score the app has ever shown becomes meaningless.
 *
 * So both halves are asserted with concrete numbers rather than with
 * inequalities, and a clean run of the same length is scored alongside as the
 * control.
 */

import { describe, it, expect } from 'vitest';
import { Session, nextSessionId } from '../src/session';
import type { ResolvedTypedReference, SessionResume } from '../src/session';
import { mulberry32 } from '../src/exercises/rng';
import type {
  AnswerMode,
  BlanksStep,
  FirstLettersStep,
  OrderingStep,
  ProvideRefStep,
  RefMatchStep,
  VerseText,
} from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const words = (text: string): string[] => text.split(' ');

/**
 * Psalm 23:1-4, KJV, as `VerseText`.
 *
 * Word offsets in `lines` are 0-based and INCLUSIVE at both ends, matching
 * `PoetryLine` in @bible/core - the convention `Line` in `src/types.ts`
 * inherits. Getting that wrong here would silently shorten every picker
 * preview by one word, which is exactly the kind of thing a fixture written to
 * match the implementation would never catch.
 */
const PS23_1: VerseText = {
  verseId: 19023001,
  label: '23:1',
  words: words('The LORD is my shepherd; I shall not want.'),
  lines: [
    { start: 0, end: 4, level: 1 },
    { start: 5, end: 8, level: 2 },
  ],
  psalmTitle: 'A Psalm of David.',
  paragraphStart: true,
};

const PS23_2: VerseText = {
  verseId: 19023002,
  label: '23:2',
  words: words(
    'He maketh me to lie down in green pastures: he leadeth me beside the still waters.',
  ),
  lines: [
    { start: 0, end: 8, level: 1 },
    { start: 9, end: 15, level: 2 },
  ],
  psalmTitle: null,
  paragraphStart: false,
};

const PS23_3: VerseText = {
  verseId: 19023003,
  label: '23:3',
  words: words(
    "He restoreth my soul: he leadeth me in the paths of righteousness for his name's sake.",
  ),
  lines: [
    { start: 0, end: 3, level: 1 },
    { start: 4, end: 15, level: 2 },
  ],
  psalmTitle: null,
  paragraphStart: false,
};

const PS23_4: VerseText = {
  verseId: 19023004,
  label: '23:4',
  words: words(
    'Yea, though I walk through the valley of the shadow of death, I will fear no evil: ' +
      'for thou art with me; thy rod and thy staff they comfort me.',
  ),
  lines: [
    { start: 0, end: 11, level: 1 },
    { start: 12, end: 21, level: 2 },
    { start: 22, end: 29, level: 2 },
  ],
  psalmTitle: null,
  paragraphStart: false,
};

/** A lone single verse - the material the `refmatch` rung is built for. */
const JOHN_3_16: VerseText = {
  verseId: 43003016,
  label: '3:16',
  words: words(
    'For God so loved the world, that he gave his only begotten Son, that whosoever ' +
      'believeth in him should not perish, but have everlasting life.',
  ),
  lines: null,
  psalmTitle: null,
  paragraphStart: true,
};

const PSALM_23 = [PS23_1, PS23_2, PS23_3, PS23_4];

/**
 * A ten-verse passage, for the ordering window test alone. What that test
 * checks is verse-id bookkeeping - which ids are eligible as candidates, not
 * anything about rendered text - so a longer synthetic passage is used rather
 * than stretching a real one out to a length nothing in the plan actually
 * memorises at once (`reference.ts#MAX_PASSAGE_VERSES` is 25, but ten already
 * exercises "more than the window").
 */
function tenVerseFixture(): VerseText[] {
  return Array.from({ length: 10 }, (_, i) => ({
    verseId: 90000000 + i + 1,
    label: `1:${i + 1}`,
    words: words(`Verse number ${i + 1} of the fixture passage here.`),
    lines: null,
    psalmTitle: null,
    paragraphStart: i === 0,
  }));
}

const SELF = { passageId: 1, reference: 'Psalm 23:1-4' };
const SIBLINGS = [
  { passageId: 2, reference: 'John 3:16' },
  { passageId: 3, reference: 'Romans 8:28' },
];

function makeSession(overrides: Partial<Parameters<typeof buildOpts>[0]> = {}) {
  return new Session(buildOpts(overrides));
}

function buildOpts(o: {
  rung?: 'ordering' | 'refmatch' | 'provideref' | 'blanks' | 'firstletters';
  verses?: VerseText[];
  answerMode?: AnswerMode;
  resume?: SessionResume;
  seed?: number;
  self?: { passageId: number; reference: string };
  siblings?: { passageId: number; reference: string }[];
} = {}) {
  return {
    sessionId: nextSessionId(),
    passageId: (o.self ?? SELF).passageId,
    cardId: 10,
    rung: o.rung ?? ('ordering' as const),
    verses: o.verses ?? PSALM_23,
    siblings: o.siblings ?? SIBLINGS,
    self: o.self ?? SELF,
    answerMode: o.answerMode ?? ('firstLetter' as const),
    rng: mulberry32(o.seed ?? 20260115),
    ...(o.resume ? { resume: o.resume } : {}),
  };
}

const orderingStep = (s: Session): OrderingStep => s.view().step as OrderingStep;
const blanksStep = (s: Session): BlanksStep => s.view().step as BlanksStep;
const firstLettersStep = (s: Session): FirstLettersStep => s.view().step as FirstLettersStep;
const refMatchStep = (s: Session): RefMatchStep => s.view().step as RefMatchStep;
const provideRefStep = (s: Session): ProvideRefStep => s.view().step as ProvideRefStep;

/**
 * Answer every ordering step correctly, in order - including the first, which
 * is a real pick too now (see `session.ts#prepareStep`'s note on why nothing
 * is given away for free any more).
 */
function playOrderingCleanly(s: Session, verses: VerseText[]): void {
  for (let i = 0; i < verses.length; i++) {
    const result = s.submit({ kind: 'ordering', verseId: verses[i]!.verseId });
    expect(result.correct).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// The blocking picker
// ---------------------------------------------------------------------------

describe('ordering - the picker blocks', () => {
  it('reports a wrong pick as blocking and does not advance the session', async () => {
    // The picker is the one exercise that refuses to move on. An ordering
    // step that let the user continue after a miss would leave the wrong
    // order unresolved in their head, which is worse than no exercise: it
    // actively teaches the mistake.
    const s = makeSession({ rung: 'ordering' });
    const before = orderingStep(s);
    expect(before.stepNumber).toBe(1);
    expect(before.totalSteps).toBe(4);
    // Nothing is placed yet: the first verse is a real pick, not a freebie.
    expect(before.placed).toEqual([]);

    // Pick a verse that is genuinely in the candidate list but is not first.
    const result = s.submit({ kind: 'ordering', verseId: PS23_4.verseId });
    expect(result.correct).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.wrong).toEqual([PS23_4.verseId]);
    // No `reveal`: the answer stays hidden until the user finds it, or the
    // step stops being an exercise while still demanding a click.
    expect(result.reveal).toBeUndefined();

    const after = orderingStep(s);
    expect(after.stepNumber).toBe(1);
    expect(after.placed).toEqual([]);
    expect(s.isFinished).toBe(false);
  });

  it('serves the identical candidates on a retry, in the identical order', async () => {
    // This is the assertion that stops a user rerolling past a verse they
    // cannot recall. The candidate list is chosen once per step and held, so
    // a wrong pick re-serves the same question - if it were rebuilt from the
    // session's (stateful) RNG on each render, the list would reshuffle and
    // the user's "not that one" mark would point at a different verse every
    // time, which reads as the app cheating.
    const s = makeSession({ rung: 'ordering' });
    const first = JSON.stringify(orderingStep(s).candidates);

    s.submit({ kind: 'ordering', verseId: PS23_4.verseId });
    expect(JSON.stringify(orderingStep(s).candidates)).toBe(first);

    // Twice, because a single re-render might coincidentally reproduce a
    // two-element permutation; three identical reads will not.
    s.submit({ kind: 'ordering', verseId: PS23_3.verseId });
    expect(JSON.stringify(orderingStep(s).candidates)).toBe(first);
  });

  it('draws distractors only from verses not yet placed', async () => {
    // A candidate the user has already watched being placed is not a
    // distractor, it is noise - and worse, it makes the exercise solvable by
    // elimination rather than by recall.
    const s = makeSession({ rung: 'ordering' });
    s.submit({ kind: 'ordering', verseId: PS23_1.verseId }); // correct: the first verse

    const step = orderingStep(s);
    expect(step.stepNumber).toBe(2);
    expect(step.placed).toEqual([PS23_1]);
    const ids = step.candidates.map((c) => c.verseId);
    expect(ids).not.toContain(PS23_1.verseId);
    expect(ids).toContain(PS23_2.verseId);
  });

  it('always includes the correct answer among the candidates', async () => {
    // A picker missing its own answer is unwinnable, and because the picker
    // blocks it would strand the session with no way forward at all.
    const s = makeSession({ rung: 'ordering' });
    for (let i = 0; i < PSALM_23.length; i++) {
      const step = orderingStep(s);
      expect(step.candidates.map((c) => c.verseId)).toContain(PSALM_23[i]!.verseId);
      s.submit({ kind: 'ordering', verseId: PSALM_23[i]!.verseId });
    }
  });

  it('reveals the answer once the step is finally resolved', async () => {
    const s = makeSession({ rung: 'ordering' });
    const result = s.submit({ kind: 'ordering', verseId: PS23_1.verseId });
    expect(result.reveal).toEqual({ verseId: PS23_1.verseId });
  });

  it('draws candidates only from the next ORDERING_WINDOW unplaced verses, not the whole remainder', async () => {
    // A pool as wide as the rest of the passage would make a long passage's
    // early steps easy for the wrong reason (a distractor from ten verses
    // away is rejected on unfamiliarity alone, not recognised as wrong), and
    // - the actual bug report - a pool no wider than what is shown forces
    // every remaining verse to appear every time, which degenerates into a
    // fixed, learnable cycle. Ten verses, so step 1's window (the next six)
    // provably excludes some of what is left.
    const TEN = tenVerseFixture();
    const s = makeSession({ rung: 'ordering', verses: TEN });

    const step = orderingStep(s);
    const ids = step.candidates.map((c) => c.verseId);
    expect(ids).toHaveLength(4); // PICKER_CHOICES
    expect(ids).toContain(TEN[0]!.verseId); // the correct answer is always offered

    // Nothing from outside verses[0..5] (the next-six window) can appear -
    // in particular nothing from verse 7 on.
    const windowIds = TEN.slice(0, 6).map((v) => v.verseId);
    for (const id of ids) expect(windowIds).toContain(id);
    for (const v of TEN.slice(6)) expect(ids).not.toContain(v.verseId);

    // The window (6) is wider than what is shown (4): of the five OTHER
    // verses it contains, only three become distractors, so - regardless of
    // rng - at least one window verse is always left out. That is what makes
    // which four appear itself unpredictable, not just their order.
    const shown = new Set(ids);
    expect(windowIds.filter((id) => !shown.has(id)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Credit forfeited, step still counted
// ---------------------------------------------------------------------------

describe('ordering - scoring', () => {
  it('scores a clean run 1, over n steps', async () => {
    // The control for the test below. Ordering is `n` steps: the first verse
    // is a real pick now, not given away for free.
    const s = makeSession({ rung: 'ordering' });
    playOrderingCleanly(s, PSALM_23);

    expect(s.isFinished).toBe(true);
    expect(s.correctFirst).toBe(4);
    expect(s.gradedTotal).toBe(4);
    expect(s.score).toBe(1);
  });

  it('forfeits the credit for a step that was missed, but still counts it', async () => {
    // Both halves matter and they pull in opposite directions. Not counting
    // the step at all would score a blocked-then-solved run 2/2 = 1.0 -
    // identical to knowing it. Counting the retries as extra steps would
    // score a five-guess fumble worse than a one-guess one, turning the
    // number into a measure of guessing stamina. The unit is counted ONCE, at
    // the moment it is spoiled, and can never earn credit afterwards.
    const s = makeSession({ rung: 'ordering' });

    s.submit({ kind: 'ordering', verseId: PS23_4.verseId }); // wrong (step 1: which comes first)
    s.submit({ kind: 'ordering', verseId: PS23_3.verseId }); // wrong again
    const recovered = s.submit({ kind: 'ordering', verseId: PS23_1.verseId }); // right
    expect(recovered.correct).toBe(true);

    // One unit counted so far, none of it credited.
    expect(s.gradedTotal).toBe(1);
    expect(s.correctFirst).toBe(0);

    s.submit({ kind: 'ordering', verseId: PS23_2.verseId });
    s.submit({ kind: 'ordering', verseId: PS23_3.verseId });
    s.submit({ kind: 'ordering', verseId: PS23_4.verseId });

    expect(s.isFinished).toBe(true);
    expect(s.gradedTotal).toBe(4);
    expect(s.correctFirst).toBe(3);
    expect(s.score).toBeCloseTo(3 / 4, 10);

    // The control: same length, same passage, no misses.
    const clean = makeSession({ rung: 'ordering' });
    playOrderingCleanly(clean, PSALM_23);
    expect(clean.gradedTotal).toBe(s.gradedTotal);
    expect(s.score).toBeLessThan(clean.score);
  });

  it('does not let repeated guessing inflate or deflate the step count', async () => {
    // Five wrong picks on one step is still one step. If retries counted as
    // steps, a user who eventually got every verse right would score close to
    // zero, and the ladder would never promote anyone who ever hesitated.
    const s = makeSession({ rung: 'ordering' });
    for (let i = 0; i < 5; i++) {
      s.submit({ kind: 'ordering', verseId: PS23_4.verseId }); // wrong every time
    }
    expect(s.gradedTotal).toBe(1);
    s.submit({ kind: 'ordering', verseId: PS23_1.verseId }); // right, at last
    expect(s.gradedTotal).toBe(1);
  });

  it('gives a fresh step its own chance at credit after an earlier miss', async () => {
    // `spoiled` is per-step state, not per-session. A user who fumbles the
    // first verse and then recites the rest perfectly must be able to earn
    // those later points, or one slip would zero the whole attempt.
    const s = makeSession({ rung: 'ordering' });
    s.submit({ kind: 'ordering', verseId: PS23_4.verseId }); // spoil step 1
    s.submit({ kind: 'ordering', verseId: PS23_1.verseId }); // resolve step 1
    s.submit({ kind: 'ordering', verseId: PS23_2.verseId }); // step 2, clean
    expect(s.correctFirst).toBe(1);
    expect(s.gradedTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Blanks and first letters do not block
// ---------------------------------------------------------------------------

describe('blanks', () => {
  it('does not block, and grades per word', async () => {
    // Unlike the picker, seeing the answer and moving on IS the point.
    // Blocking here would sit the user on a word they genuinely cannot recall
    // with no way forward; the card's schedule is what brings it back.
    const s = makeSession({ rung: 'blanks', verses: [PS23_1, PS23_2] });
    const step = blanksStep(s);
    expect(step.kind).toBe('blanks');
    expect(step.totalSteps).toBe(2);
    expect(step.blankIndices.length).toBeGreaterThan(0);

    // Answer every blank correctly except the first.
    const answers = step.blankIndices.map((i) => PS23_1.words[i] as string);
    answers[0] = 'donkey';

    const result = s.submit({ kind: 'blanks', words: answers });
    expect(result.blocking).toBe(false);
    expect(result.correct).toBe(false);
    // `wrong` is indices into `verse.words`, not positions within `typed` -
    // the panel highlights a word in the rendered verse, and translating back
    // from a position would put that mapping in two places.
    expect(result.wrong).toEqual([step.blankIndices[0]]);

    // And the session moved on regardless of the miss.
    expect(blanksStep(s).stepNumber).toBe(2);
  });

  it('credits every blank the user got right, not the step as a whole', async () => {
    // The scoring unit for blanks is the word. A step-level pass/fail would
    // make a single missed word cost as much as an empty submission, and the
    // 0.8 pass threshold would become unreachable on any long verse.
    const s = makeSession({ rung: 'blanks', verses: [PS23_1] });
    const step = blanksStep(s);
    const total = step.blankIndices.length;
    const answers = step.blankIndices.map((i) => PS23_1.words[i] as string);
    answers[0] = '';

    s.submit({ kind: 'blanks', words: answers });
    expect(s.gradedTotal).toBe(total);
    expect(s.correctFirst).toBe(total - 1);
    expect(s.score).toBeCloseTo((total - 1) / total, 10);
  });

  it('accepts a word typed without the punctuation the text prints', async () => {
    // `verse.words` is a raw whitespace split, so tokens arrive as
    // `shepherd;` and `pastures:`. A user who recited the verse perfectly
    // does not conclude "I should have typed the semicolon" when marked
    // wrong - they conclude the app is broken and stop trusting every score
    // it has shown them. The session has to route through `wordsMatch` for
    // this to hold, which is what this asserts at the session level.
    const s = makeSession({ rung: 'blanks', verses: [PS23_1] });
    const step = blanksStep(s);
    const answers = step.blankIndices.map(
      (i) => (PS23_1.words[i] as string).replace(/[;:.,]/g, ''),
    );
    const result = s.submit({ kind: 'blanks', words: answers });
    expect(result.wrong).toEqual([]);
    expect(result.correct).toBe(true);
    expect(s.score).toBe(1);
  });

  it('counts an empty submission wrong rather than unanswered', async () => {
    // There is no third state in the score. A user who skipped every gap did
    // not fail to be measured, they failed to recall.
    const s = makeSession({ rung: 'blanks', verses: [PS23_1] });
    const total = blanksStep(s).blankIndices.length;
    const result = s.submit({ kind: 'blanks', words: [] });
    expect(result.correct).toBe(false);
    expect(result.wrong).toHaveLength(total);
    expect(s.correctFirst).toBe(0);
    expect(s.score).toBe(0);
  });

  it('reveals the hidden words in blank order', async () => {
    // Paired positionally with `blankIndices` so the panel can show the right
    // answer beside the gap it belongs to without a second lookup.
    const s = makeSession({ rung: 'blanks', verses: [PS23_3] });
    const step = blanksStep(s);
    const result = s.submit({ kind: 'blanks', words: [] });
    expect(result.reveal?.words).toEqual(step.blankIndices.map((i) => PS23_3.words[i]));
  });
});

describe('firstletters', () => {
  it('does not block, and grades every word of the verse', async () => {
    // The top rung: the initial is given, so there is no credit for producing
    // it - the whole word is the unit. Nothing here is worth retrying in the
    // same sitting, so it does not block either.
    const s = makeSession({ rung: 'firstletters', verses: [PS23_1, PS23_2] });
    const step = firstLettersStep(s);
    expect(step.kind).toBe('firstletters');
    expect(step.totalSteps).toBe(2);

    const first = s.submit({ kind: 'firstletters', words: PS23_1.words });
    expect(first.blocking).toBe(false);
    expect(first.correct).toBe(true);
    expect(first.reveal?.words).toEqual(PS23_1.words);

    // Second verse: three words wrong out of sixteen.
    const typed = [...PS23_2.words];
    typed[1] = 'giveth';
    typed[7] = 'grey';
    typed[14] = 'quiet';
    const second = s.submit({ kind: 'firstletters', words: typed });
    expect(second.blocking).toBe(false);
    expect(second.wrong).toEqual([1, 7, 14]);

    // 9 words in verse one, 16 in verse two, three of them missed.
    expect(s.gradedTotal).toBe(25);
    expect(s.correctFirst).toBe(22);
    expect(s.score).toBeCloseTo(22 / 25, 10);
    expect(s.isFinished).toBe(true);
  });

  it('counts words the user stopped short of as wrong', async () => {
    // Stopping is a recall failure, not a missing measurement - the short
    // array is exactly what the panel sends when the user gives up halfway.
    const s = makeSession({ rung: 'firstletters', verses: [PS23_1] });
    const result = s.submit({ kind: 'firstletters', words: PS23_1.words.slice(0, 4) });
    expect(result.wrong).toEqual([4, 5, 6, 7, 8]);
    expect(s.correctFirst).toBe(4);
    expect(s.gradedTotal).toBe(9);
  });

  it("holds the internal apostrophe in name's against a user who drops it", async () => {
    // The one place the comparison chooses strictness over leniency:
    // `name's` and `names` are different words, and accepting the second
    // would mark a genuine recall failure correct. Asserted through the
    // session because it is the session that hands raw verse tokens to the
    // grader.
    const s = makeSession({ rung: 'firstletters', verses: [PS23_3] });
    const typed = [...PS23_3.words];
    typed[14] = 'names';
    const result = s.submit({ kind: 'firstletters', words: typed });
    expect(result.wrong).toEqual([14]);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('a finished session', () => {
  it('reports isFinished, a null step and the score it earned', async () => {
    // The panel keys off `step === null` to swap to the summary screen, and
    // off `isFinished` to stop submitting. Both have to flip together or the
    // panel renders an exercise with nothing in it.
    const s = makeSession({ rung: 'ordering' });
    playOrderingCleanly(s, PSALM_23);

    expect(s.isFinished).toBe(true);
    const view = s.view();
    expect(view.step).toBeNull();
    expect(view.correctFirst).toBe(4);
    expect(view.stepsTaken).toBe(4);
    expect(s.score).toBe(1);
  });

  it('refuses further submissions without throwing', async () => {
    // A stale submit from a panel that had not yet processed the summary must
    // not reach the graders - and must not throw either, because an exception
    // across the RPC boundary arrives at the panel as an opaque failure that
    // loses the session.
    const s = makeSession({ rung: 'ordering' });
    playOrderingCleanly(s, PSALM_23);

    const late = s.submit({ kind: 'ordering', verseId: PS23_2.verseId });
    expect(late).toEqual({ correct: false, wrong: [], blocking: false });
    expect(s.correctFirst).toBe(4);
    expect(s.gradedTotal).toBe(4);
  });

  it('treats an answer of the wrong kind as a blocking miss, not an exception', async () => {
    // Only reachable when the panel and worker disagree about session
    // position - a stale reply after a restart. Reported as an ordinary wrong
    // answer so the session survives it.
    const s = makeSession({ rung: 'ordering' });
    const result = s.submit({ kind: 'blanks', words: ['nonsense'] });
    expect(result.correct).toBe(false);
    expect(result.blocking).toBe(true);
    expect(s.isFinished).toBe(false);
  });

  it('carries the answer mode through to blanks and firstletters steps', () => {
    // Task 0004: every hidden-word step tells the panel how to collect the
    // answer, because `blanks` and `firstletters` share one rendering
    // mechanic that only differs by which words are hidden.
    const blanks = makeSession({ rung: 'blanks', verses: [PS23_1], answerMode: 'fullWord' });
    expect(blanksStep(blanks).answerMode).toBe('fullWord');

    const letters = makeSession({ rung: 'firstletters', verses: [PS23_1], answerMode: 'firstLetter' });
    expect(firstLettersStep(letters).answerMode).toBe('firstLetter');
  });

  it('resumes at the given cursor with the prior tally intact', () => {
    // The resume point is written to disk after each verse (see
    // `main.ts#submitStep`) and handed back in here on the next `startSession`
    // - this is the one place `Session` has to trust state it did not compute
    // itself.
    const s = makeSession({
      rung: 'blanks',
      verses: PSALM_23,
      resume: { cursor: 2, correctFirstUnits: 5, gradedUnits: 6 },
    });
    expect(blanksStep(s).stepNumber).toBe(3);
    expect(s.correctFirst).toBe(5);
    expect(s.gradedTotal).toBe(6);
  });

  it('ignores a resume point at or past the end, starting fresh instead', () => {
    // A resume row can outlive the activity it describes - the collection
    // changed shape, or the row is simply stale. Starting fresh is the safe
    // default; a session that could not produce a step at all would be worse
    // than one that quietly forgets a bad resume point.
    const s = makeSession({
      rung: 'blanks',
      verses: [PS23_1],
      resume: { cursor: 1, correctFirstUnits: 3, gradedUnits: 3 },
    });
    expect(blanksStep(s).stepNumber).toBe(1);
    expect(s.correctFirst).toBe(0);
  });

  it('gives every session a distinct id', async () => {
    // The panel holds only the id; two live sessions sharing one would route
    // the second one's answers into the first.
    expect(nextSessionId()).not.toBe(nextSessionId());
  });
});

// ---------------------------------------------------------------------------
// refmatch
// ---------------------------------------------------------------------------

describe('refmatch', () => {
  it('is a single step', async () => {
    // A lone verse has exactly one question to answer: which reference is
    // this? Presenting it as "step 1 of 1" rather than iterating the (single)
    // verse array is what keeps the progress indicator honest.
    const s = makeSession({
      rung: 'refmatch',
      verses: [JOHN_3_16],
      self: { passageId: 2, reference: 'John 3:16' },
      siblings: [
        { passageId: 1, reference: 'Psalm 23:1-4' },
        { passageId: 3, reference: 'Romans 8:28' },
      ],
    });
    const step = refMatchStep(s);
    expect(step.kind).toBe('refmatch');
    expect(step.stepNumber).toBe(1);
    expect(step.totalSteps).toBe(1);
    expect(step.verse).toEqual(JOHN_3_16);

    const result = s.submit({ kind: 'refmatch', passageId: 2 });
    expect(result.correct).toBe(true);
    expect(result.blocking).toBe(false);
    expect(s.isFinished).toBe(true);
    expect(s.view().step).toBeNull();
    expect(s.gradedTotal).toBe(1);
    expect(s.correctFirst).toBe(1);
    expect(s.score).toBe(1);
  });

  it('offers the correct reference alongside real distractors', async () => {
    // The distractors are the other passages in the plan, which is what makes
    // this an exercise rather than a formality - and why a lone passage skips
    // the rung entirely.
    const s = makeSession({
      rung: 'refmatch',
      verses: [JOHN_3_16],
      self: { passageId: 2, reference: 'John 3:16' },
      siblings: [
        { passageId: 1, reference: 'Psalm 23:1-4' },
        { passageId: 3, reference: 'Romans 8:28' },
      ],
    });
    const ids = refMatchStep(s).candidates.map((c) => c.passageId).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  it('blocks on a wrong reference and forfeits the credit', async () => {
    // Same rule as the ordering picker: you always finish, and finishing is
    // not the same as being right. A single-step exercise makes the
    // consequence stark - the attempt scores exactly 0.
    const s = makeSession({
      rung: 'refmatch',
      verses: [JOHN_3_16],
      self: { passageId: 2, reference: 'John 3:16' },
      siblings: [{ passageId: 3, reference: 'Romans 8:28' }],
    });

    const missed = s.submit({ kind: 'refmatch', passageId: 3 });
    expect(missed.correct).toBe(false);
    expect(missed.blocking).toBe(true);
    expect(missed.wrong).toEqual([3]);
    expect(s.isFinished).toBe(false);

    const recovered = s.submit({ kind: 'refmatch', passageId: 2 });
    expect(recovered.correct).toBe(true);
    expect(s.isFinished).toBe(true);
    expect(s.correctFirst).toBe(0);
    expect(s.gradedTotal).toBe(1);
    expect(s.score).toBe(0);
  });

  it('keeps the candidate order fixed across renders and across a retry', () => {
    // The regression: `currentStep()` used to build and shuffle this list
    // inline with the session's *stateful* RNG, so every call to `view()`
    // returned a different order. Two consequences, both bad and both
    // invisible in a passing test that only ever rendered once:
    //
    //  - the transient "not that one" mark is positional, so on the re-serve
    //    after a wrong pick it pointed at whatever reference had moved into
    //    that slot - telling the user the wrong thing about their own answer;
    //  - a user could retry to reroll the layout, which is the same reroll
    //    the ordering picker caches `currentCandidates` to prevent.
    //
    // A panel reopen or a pop-out re-renders too, so this fired well outside
    // the retry path.
    const s = makeSession({
      rung: 'refmatch',
      verses: [JOHN_3_16],
      self: { passageId: 2, reference: 'John 3:16' },
      siblings: SIBLINGS,
    });

    const order = () =>
      ((s.view().step as RefMatchStep).candidates ?? []).map((c) => c.passageId);

    const first = order();
    expect(order()).toEqual(first);
    expect(order()).toEqual(first);

    // A wrong pick re-serves the same step; it must be the *same* step.
    s.submit({ kind: 'refmatch', passageId: 3 });
    expect(s.isFinished).toBe(false);
    expect(order()).toEqual(first);
    expect(order()).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// provideref (M7) - a numeric verse-range comparison, never a string one
// ---------------------------------------------------------------------------

describe('provideref', () => {
  const CORRECT_RANGE: ResolvedTypedReference = {
    ok: true,
    startVerseId: PS23_1.verseId,
    endVerseId: PS23_4.verseId,
  };

  it('is a single step over the whole passage', async () => {
    // Like `refmatch`, one question - but here it is the whole passage shown
    // plainly, not one verse among candidates.
    const s = makeSession({ rung: 'provideref', verses: PSALM_23 });
    const step = provideRefStep(s);
    expect(step.kind).toBe('provideref');
    expect(step.stepNumber).toBe(1);
    expect(step.totalSteps).toBe(1);
    expect(step.verses).toEqual(PSALM_23);
  });

  it('grades the exact range correct, finishing the session with score 1', async () => {
    const s = makeSession({ rung: 'provideref', verses: PSALM_23 });
    const result = s.submitProvideRef(CORRECT_RANGE);

    expect(result).toEqual({ correct: true, wrong: [], blocking: false });
    expect(s.isFinished).toBe(true);
    expect(s.view().step).toBeNull();
    expect(s.gradedTotal).toBe(1);
    expect(s.correctFirst).toBe(1);
    expect(s.score).toBe(1);
  });

  it('grades a subset range wrong - right start, short end - guarding against an "overlap" grader', async () => {
    // The comparison is exact-range, not "does it overlap": a resolved range
    // that starts correctly but stops early (or runs long) is not the
    // passage's own reference and must not slip through as a match.
    const s = makeSession({ rung: 'provideref', verses: PSALM_23 });
    const result = s.submitProvideRef({
      ok: true,
      startVerseId: PS23_1.verseId,
      endVerseId: PS23_3.verseId,
    });

    expect(result.correct).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.reveal).toEqual({ reference: SELF.reference });
    expect(s.isFinished).toBe(true);
    expect(s.gradedTotal).toBe(1);
    expect(s.correctFirst).toBe(0);
    expect(s.score).toBe(0);
  });

  it('grades a different book wrong and reveals the passage\'s own reference', async () => {
    const s = makeSession({ rung: 'provideref', verses: PSALM_23 });
    const result = s.submitProvideRef({
      ok: true,
      startVerseId: JOHN_3_16.verseId,
      endVerseId: JOHN_3_16.verseId,
    });

    expect(result.correct).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.reveal).toEqual({ reference: SELF.reference });
    expect(s.isFinished).toBe(true);
  });

  it('does not grade or spoil an unrecognised string - it is a typo, not a claim', async () => {
    const s = makeSession({ rung: 'provideref', verses: PSALM_23 });
    const reason = '"xyz" is not a reference I recognise. Try something like "John 3:16-18".';
    const result = s.submitProvideRef({ ok: false, reason });

    expect(result).toEqual({ correct: false, wrong: [], blocking: true, note: reason });
    expect(s.isFinished).toBe(false);
    expect(s.gradedTotal).toBe(0);
    expect(s.correctFirst).toBe(0);

    // The same step comes back, and a later real answer scores as if the
    // unparsed attempt had never happened - it neither counted nor spoiled.
    const step = provideRefStep(s);
    expect(step.verses).toEqual(PSALM_23);

    const recovered = s.submitProvideRef(CORRECT_RANGE);
    expect(recovered.correct).toBe(true);
    expect(s.isFinished).toBe(true);
    expect(s.gradedTotal).toBe(1);
    expect(s.correctFirst).toBe(1);
    expect(s.score).toBe(1);
  });

  it('returns the ordinary mismatch shape if reached through the generic submit() at all', async () => {
    // Unreachable in normal operation - `main.ts#submitStep` calls
    // `submitProvideRef` directly for a `provideref` answer - but the switch
    // in `submit()` has to stay exhaustive and report a `provideref` answer
    // the same way every other kind mismatch is reported, rather than
    // throwing.
    const s = makeSession({ rung: 'provideref', verses: PSALM_23 });
    const result = s.submit({ kind: 'provideref', text: 'Psalm 23:1-4' });
    expect(result).toEqual({ correct: false, wrong: [], blocking: true });
    expect(s.isFinished).toBe(false);
  });
});
