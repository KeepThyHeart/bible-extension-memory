/**
 * Pure formatting and selection helpers for the panel.
 *
 * Nothing in this file touches the DOM. That is deliberate and load-bearing:
 * the panel bundle is built for a browser realm, but `vitest.config.ts` runs
 * the suite under `environment: 'node'`, so anything that reaches for
 * `document` at import time cannot be unit tested without dragging in a DOM
 * shim. Keeping the decisions - which card is next, what a due date reads as,
 * how a score is phrased - in a DOM-free module means the interesting logic is
 * testable and the untestable part is reduced to "put this string in that
 * element".
 *
 * Every function that depends on the clock takes `now` as an argument for the
 * same reason. A helper that calls `Date.now()` internally can only be tested
 * by freezing time globally, which makes the test order-dependent.
 */

import type { AnalyticsView, PassageView, PlanView, Rung, RungView } from '../types';
import { RUNG_ORDER } from '../types';
import { MIN_PASSAGES_FOR_REFMATCH } from '../ladder';
import type { ActivityTile } from './activities';
// Type-only: erased at compile time, so this creates no runtime edge back to
// `state.ts` for `panel.ts`'s module graph to resolve, even though `state.ts`
// itself imports nothing from here - see `Flow`'s own note in `state.ts`.
import type { Flow } from './state';

/**
 * The level at and above which an activity counts as mastered.
 *
 * Shared by `components.ts#levelBoxes` (green fill) and `carriesDownFrom`
 * below (the "harder carries down" rule) so the two never quietly disagree
 * about what "mastered" means.
 */
export const MASTERED_LEVEL = 4;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Human names for the rungs, now called "activities" everywhere the user
 * reads them - "rung" and "ladder" are this codebase's internal vocabulary
 * for the mechanism, not words a learner needs.
 */
export const RUNG_LABEL: Readonly<Record<Rung, string>> = {
  ordering: 'Put in order',
  refmatch: 'Match the reference',
  blanks: 'Fill in the blanks',
  firstletters: 'First letters only',
};

/** What each activity asks of the user, in one line. */
export const RUNG_BLURB: Readonly<Record<Rung, string>> = {
  ordering: 'Choose which verse comes next, with the earlier verses in view.',
  refmatch: 'Given the words, choose the reference they belong to.',
  blanks: 'Type the words that have been removed from the passage.',
  firstletters: 'Every word is hidden. Recall the whole verse.',
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Midnight local time for the day containing `ms`.
 *
 * "Due tomorrow" is a *calendar* claim, not an arithmetic one: something due
 * in 20 hours is due tomorrow if it is currently 9pm and later today if it is
 * currently 1am. Subtracting epoch milliseconds and dividing by 86 400 000
 * gets that wrong roughly half the time, so days are compared as days.
 */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from the day of `from` to the day of `to`. */
export function calendarDaysBetween(from: number, to: number): number {
  return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / MS_PER_DAY);
}

/** A short absolute date - "12 Mar" this year, "12 Mar 2027" beyond it. */
export function formatShortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * How a `dueAt` reads on screen.
 *
 * `null` means the activity has never been attempted, which is the normal
 * state for something the user has not gotten to yet and must not read like
 * an error.
 */
export function formatDue(dueAt: number | null, now: number): string {
  if (dueAt === null) return 'Not tried yet';
  if (dueAt <= now) return 'Due now';

  const days = calendarDaysBetween(now, dueAt);
  if (days <= 0) return 'Due later today';
  if (days === 1) return 'Due tomorrow';
  if (days < 7) return `Due in ${days} days`;
  return `Due ${formatShortDate(dueAt, now)}`;
}

/** True when an activity is scheduled and its time has come. */
export function isDue(rung: RungView, now: number): boolean {
  return rung.applicable && rung.dueAt !== null && rung.dueAt <= now;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A 0..1 score as a percentage.
 *
 * `null` is "never attempted", which is different from zero and has to look
 * different: an activity the user has never tried is not one they failed.
 */
export function formatScore(score: number | null): string {
  if (score === null) return '—';
  return `${Math.round(score * 100)}%`;
}

/** "Step 3 of 7". Defensive about a zero total so the header never reads "of 0". */
export function formatStepProgress(stepNumber: number, totalSteps: number): string {
  if (totalSteps <= 0) return `Step ${stepNumber}`;
  return `Step ${stepNumber} of ${totalSteps}`;
}

/** A 0..1 fraction as a percentage clamped to the bar's range. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value * 100));
}

/** Pluralises a count and its noun together: "1 verse", "3 verses". */
export function countLabel(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * The comparable core of a word: letters and digits, case-folded.
 *
 * Used by the letter-reveal renderer to decide whether the key that was just
 * pressed is the right initial. Scoring itself stays in the worker - the panel
 * must never be the authority on whether an answer was right, because the two
 * halves would then have two definitions of correct. This is only the local
 * affordance that lets a keystroke reveal a word without a round trip.
 *
 * Apostrophes are stripped along with the rest of the punctuation so that
 * "'tis" answers to `t`; a leading quotation mark must not swallow the letter
 * the user is being asked for.
 */
export function wordCore(word: string): string {
  return word.replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
}

/** The initial a letter-reveal box tests a keystroke against. */
export function firstLetterOf(word: string): string {
  return wordCore(word).slice(0, 1);
}

/** True when `typed` is the initial `word` is asking for. */
export function matchesFirstLetter(typed: string, word: string): boolean {
  const want = firstLetterOf(word);
  if (want === '') return true;
  return wordCore(typed).slice(0, 1) === want;
}

// ---------------------------------------------------------------------------
// Choosing what to practise
// ---------------------------------------------------------------------------

/** What a "Start practicing" button will start, if anything. */
export interface PracticeTarget {
  passageId: number;
  rung: Rung;
  reference: string;
  dueAt: number | null;
}

/**
 * The single highest-priority due activity across the whole plan.
 *
 * The order is: longest overdue first, then lowest rung, then oldest passage.
 *
 * Rung order breaks the tie rather than passage order because the ladder is a
 * dependency chain - there is no point drilling first-letters on one passage
 * while an ordering card on another has been waiting the same number of days,
 * since the ordering card is the one holding up its own passage's progress.
 * The passage id is the final tiebreak purely so the button is deterministic;
 * a "random due card" button is one the user cannot form a habit around.
 *
 * `exclude`, when given, is a set of passage ids to leave out of the search
 * entirely - the Variety flow's Next/skip control (N6) uses it to avoid
 * re-offering a passage the user just skipped past.
 */
export function pickDueTarget(plan: PlanView, now: number, exclude?: ReadonlySet<number>): PracticeTarget | null {
  let best: PracticeTarget | null = null;

  for (const pv of plan.passages) {
    if (exclude?.has(pv.passage.id)) continue;
    for (const rv of pv.rungs) {
      if (!isDue(rv, now)) continue;
      const candidate: PracticeTarget = {
        passageId: pv.passage.id,
        rung: rv.rung,
        reference: pv.passage.reference,
        dueAt: rv.dueAt,
      };
      if (best === null || comparePriority(candidate, best) < 0) best = candidate;
    }
  }

  return best;
}

function comparePriority(a: PracticeTarget, b: PracticeTarget): number {
  if (a.dueAt !== b.dueAt) return (a.dueAt ?? 0) - (b.dueAt ?? 0);
  const rungDelta = RUNG_ORDER.indexOf(a.rung) - RUNG_ORDER.indexOf(b.rung);
  if (rungDelta !== 0) return rungDelta;
  return a.passageId - b.passageId;
}

/**
 * The activity a passage's own "Practice" button should start, and the one
 * badged "Suggested" on the passage screen: whichever applicable activity is
 * due soonest; failing that, the first applicable activity that has not
 * reached "well learned" (level 4); failing that (everything mastered), the
 * hardest one, as an upkeep suggestion.
 *
 * Unlike v0's `pickRungForPassage`, this never returns null: nothing is
 * locked or exempt from suggestion any more, so there is always something to
 * offer. `main.ts#suggestedRungForPassage` implements the same rule
 * worker-side for the "Start practicing" button, which does not have a
 * `RungView[]` to hand.
 */
export function suggestedRungFor(rungs: RungView[], now: number): Rung | null {
  const applicable = rungs.filter((r) => r.applicable);
  if (applicable.length === 0) return null;

  const due = applicable.filter((r) => isDue(r, now));
  if (due.length > 0) {
    due.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    return due[0]!.rung;
  }

  for (const rung of RUNG_ORDER) {
    const rv = applicable.find((r) => r.rung === rung);
    if (rv && rv.level < 4) return rv.rung;
  }
  return applicable[applicable.length - 1]!.rung;
}

/**
 * What "Start practicing" on the home screen offers: the plan's highest-
 * priority due activity, or - when nothing is due - the suggested activity of
 * the most recently added passage, so the button always does something.
 *
 * `exclude` is forwarded to `pickDueTarget` and also applied to the
 * most-recently-added fallback below, for the same reason - see its note
 * on `pickDueTarget`.
 */
export function pickStartTarget(plan: PlanView, now: number, exclude?: ReadonlySet<number>): PracticeTarget | null {
  const due = pickDueTarget(plan, now, exclude);
  if (due) return due;

  const candidates = exclude ? plan.passages.filter((pv) => !exclude.has(pv.passage.id)) : plan.passages;
  if (candidates.length === 0) return null;

  const latest = [...candidates].sort((a, b) => b.passage.addedAt - a.passage.addedAt)[0]!;
  const rung = suggestedRungFor(latest.rungs, now);
  if (!rung) return null;
  const rv = latest.rungs.find((r) => r.rung === rung);
  return { passageId: latest.passage.id, rung, reference: latest.passage.reference, dueAt: rv?.dueAt ?? null };
}

/**
 * True when `rung` itself has not been mastered, but a harder rung (later in
 * `RUNG_ORDER`) has - the "harder activity carries down" rule from task
 * 0004's review, point 10. `bestLevel`/`wellLearned` already apply this at
 * the whole-passage level; this is the per-activity version the plan row's
 * compact squares need, so an activity that was never directly practised to
 * mastery can still be drawn as "passed" rather than "not started".
 */
export function carriesDownFrom(rungs: RungView[], rung: Rung): boolean {
  const index = RUNG_ORDER.indexOf(rung);
  return rungs.some(
    (r) => r.applicable && RUNG_ORDER.indexOf(r.rung) > index && r.level >= MASTERED_LEVEL,
  );
}

/**
 * Orders a rung list into ladder order regardless of what the worker sent.
 *
 * The protocol does not promise an order for `PassageView.rungs`, and the
 * passage screen's whole claim is that it shows the ladder *linearly*.
 * Sorting here rather than trusting the array means a worker change cannot
 * silently turn the screen into a shuffled list.
 */
export function inLadderOrder(rungs: RungView[]): RungView[] {
  return [...rungs].sort((a, b) => RUNG_ORDER.indexOf(a.rung) - RUNG_ORDER.indexOf(b.rung));
}

/**
 * The rungs a passage's tab strip draws a tab for, in ladder order.
 *
 * Shared by the passage screen and, from N5, the practice screen, so the two
 * tab strips can never quietly disagree about which activities count as
 * "applicable" or what order they come in - the same reasoning
 * `suggestedRungFor` already applies to picking one of them.
 */
export function applicableRungs(rungs: RungView[]): RungView[] {
  return inLadderOrder(rungs).filter((r) => r.applicable);
}

// ---------------------------------------------------------------------------
// Activity tiles (round-2 UI review, decisions 6-8)
// ---------------------------------------------------------------------------

/**
 * The smallest longest-passage verse count that makes "Put in Order"
 * worthwhile as a tile - deliberately higher than `ladder.ts#applicableRungs`'s
 * own per-passage `verseCount > 1` rule, which stays as-is and governs
 * whether an individual passage's `ordering` rung exists at all.
 *
 * `session.ts`'s `PICKER_CHOICES` is 4, and the first verse of a passage is
 * now a real pick too (bug-fix item 4), so the first step's candidate pool is
 * the whole passage: a 4-or-more-verse passage is the smallest that offers a
 * genuine four-way choice at every step. This is a *tile*-level threshold for
 * "is this activity worth offering from the home screen right now", not a
 * change to which passages ever get an `ordering` rung.
 */
const MIN_VERSES_FOR_ORDERING_TILE = 4;

/** What `activityAvailability` reports for one tile. */
export interface ActivityAvailability {
  available: boolean;
  /** Why the tile is greyed out, or what it needs. `null` when nothing need be said. */
  warning: string | null;
}

/**
 * Whether a tile catalogue entry (`activities.ts#ACTIVITY_TILES`) can be
 * pressed right now, and the warning copy to show when it cannot.
 *
 * Pure and computed from the plan, not hard-coded per tile - see the round-2
 * UI review's decision 7. `now` is accepted for signature symmetry with the
 * file's other selection helpers (and so a future, genuinely time-dependent
 * rule can be added here without changing every call site); none of the
 * current rules are clock-dependent, so it goes unused today.
 */
export function activityAvailability(
  plan: PlanView,
  tile: ActivityTile,
  _now: number,
): ActivityAvailability {
  const passageCount = plan.passages.length;

  switch (tile.id) {
    case 'provideref':
      // The exercise itself does not exist yet (M7) - always unavailable,
      // regardless of the plan's contents, until it lands.
      return { available: false, warning: 'Not available yet.' };

    case 'refmatch': {
      if (passageCount >= MIN_PASSAGES_FOR_REFMATCH) return { available: true, warning: null };
      return {
        available: false,
        warning: `Requires at least ${MIN_PASSAGES_FOR_REFMATCH} passages; you have ${passageCount} so far.`,
      };
    }

    case 'ordering': {
      const longest = plan.passages.reduce((max, pv) => Math.max(max, pv.passage.verseCount), 0);
      if (longest >= MIN_VERSES_FOR_ORDERING_TILE) return { available: true, warning: null };
      const tail = passageCount === 0 ? 'you have none yet.' : `your longest is ${longest} so far.`;
      return {
        available: false,
        warning: `Put in Order needs a passage of at least ${MIN_VERSES_FOR_ORDERING_TILE} verses; ${tail}`,
      };
    }

    case 'variety':
    case 'blanks':
    case 'firstletters':
      // Available as soon as there is anything to practise. An empty plan
      // replaces the whole tile grid with `emptyState()` (M2's job), so no
      // warning copy is needed here for that case.
      return { available: passageCount >= 1, warning: null };
  }
}

/**
 * What a tile press should start.
 *
 * `variety`: reuses `pickDueTarget` then, if nothing is due, `pickStartTarget`
 * - exactly the composition `planView.ts#renderStartPracticing` already uses
 * for the "Start practicing" button (`pickStartTarget` itself is due-target-
 * first, add-fallback-second; the two are composed again here, rather than
 * called once, only so `exclude` can be threaded through both).
 *
 * `activity`: an explicit tile names one `Rung`. Judgment call from the
 * round-2 review, kept as given: among passages where that rung is
 * *applicable* (`RungView.applicable`, the same flag `applicableRungs`
 * filters on), pick by due first (earliest `dueAt`), then never-attempted,
 * then lowest level, then oldest `addedAt`. This ladder-order preference only
 * orders among already-applicable passages - it does not gate eligibility the
 * way Variety's "hasn't passed the easier steps first" reasoning does. An
 * explicit tile press is not re-subjected to that.
 *
 * `exclude` is applied to both flows alike, for a Next/skip control (N6) that
 * should be able to skip the currently-offered passage regardless of which
 * flow is running.
 *
 * `passage` (N6's third `Flow` variant, `state.ts`) names one specific
 * passage the user was already looking at rather than a rule for choosing
 * among several, so there is nothing here for it to pick - it returns `null`.
 * In practice this case is never reached: the Next/skip control this function
 * exists for is not shown when the current flow is `passage` (see the note on
 * `NavState.flow` in `state.ts`), and no other caller passes one either.
 */
export function pickFlowTarget(
  plan: PlanView,
  flow: Flow,
  now: number,
  exclude?: ReadonlySet<number>,
): PracticeTarget | null {
  switch (flow.kind) {
    case 'variety':
      return pickDueTarget(plan, now, exclude) ?? pickStartTarget(plan, now, exclude);

    case 'passage':
      return null;

    case 'activity':
      return pickActivityTarget(plan, flow.rung, now, exclude);
  }
}

function pickActivityTarget(
  plan: PlanView,
  rung: Rung,
  now: number,
  exclude?: ReadonlySet<number>,
): PracticeTarget | null {
  const candidates = plan.passages.filter((pv) => {
    if (exclude?.has(pv.passage.id)) return false;
    const rv = pv.rungs.find((r) => r.rung === rung);
    return rv !== undefined && rv.applicable;
  });
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestRung = best.rungs.find((r) => r.rung === rung)!;
  for (const pv of candidates.slice(1)) {
    const rv = pv.rungs.find((r) => r.rung === rung)!;
    if (compareActivityCandidate(pv, rv, best, bestRung, now) < 0) {
      best = pv;
      bestRung = rv;
    }
  }

  return { passageId: best.passage.id, rung, reference: best.passage.reference, dueAt: bestRung.dueAt };
}

/** Priority order for `pickFlowTarget`'s `activity` case - see its docstring. */
function compareActivityCandidate(
  a: PassageView,
  aRung: RungView,
  b: PassageView,
  bRung: RungView,
  now: number,
): number {
  const aDue = isDue(aRung, now);
  const bDue = isDue(bRung, now);
  if (aDue !== bDue) return aDue ? -1 : 1;
  if (aDue && aRung.dueAt !== bRung.dueAt) return (aRung.dueAt ?? 0) - (bRung.dueAt ?? 0);

  const aNeverAttempted = aRung.dueAt === null;
  const bNeverAttempted = bRung.dueAt === null;
  if (aNeverAttempted !== bNeverAttempted) return aNeverAttempted ? -1 : 1;

  if (aRung.level !== bRung.level) return aRung.level - bRung.level;
  return a.passage.addedAt - b.passage.addedAt;
}

/**
 * Sorts passages by how much they need practice: due first by earliest
 * `dueAt`, then never-attempted (`bestLevel === 0`), then ascending
 * `bestLevel`, then descending `dueCount`, then ascending `addedAt` as the
 * deterministic tiebreak.
 *
 * Pure - returns a new array, per the file's convention (`inLadderOrder`
 * above does the same). Wiring this into an actual sort `<select>` is M4's
 * job; this is only the ordering function.
 */
export function sortPassagesByNeed(passages: PassageView[], now: number): PassageView[] {
  return [...passages].sort((a, b) => comparePassageNeed(a, b, now));
}

function comparePassageNeed(a: PassageView, b: PassageView, now: number): number {
  const dueDelta = compareEarliestDueAt(earliestDueAt(a, now), earliestDueAt(b, now));
  if (dueDelta !== 0) return dueDelta;

  const aNeverAttempted = a.bestLevel === 0;
  const bNeverAttempted = b.bestLevel === 0;
  if (aNeverAttempted !== bNeverAttempted) return aNeverAttempted ? -1 : 1;

  if (a.bestLevel !== b.bestLevel) return a.bestLevel - b.bestLevel;
  if (a.dueCount !== b.dueCount) return b.dueCount - a.dueCount;
  return a.passage.addedAt - b.passage.addedAt;
}

/** The soonest `dueAt` among a passage's due rungs, or `null` if none is due. */
function earliestDueAt(pv: PassageView, now: number): number | null {
  let best: number | null = null;
  for (const rv of pv.rungs) {
    if (!isDue(rv, now)) continue;
    if (best === null || (rv.dueAt ?? 0) < best) best = rv.dueAt ?? 0;
  }
  return best;
}

/** `null` (not due) always sorts after any due timestamp; earlier timestamps sort first. */
function compareEarliestDueAt(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** "5 weeks" of a practice calendar, as ISO weekday columns (Mon..Sun). */
export function calendarWeeks(analytics: AnalyticsView): AnalyticsView['calendar'][] {
  const days = analytics.calendar;
  const weeks: AnalyticsView['calendar'][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** "Tue", "Wed", ... for a calendar day, in the viewer's locale. */
export function weekdayLabel(dateMs: number): string {
  return new Date(dateMs).toLocaleDateString(undefined, { weekday: 'short' });
}
