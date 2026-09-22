/**
 * The two mastery ladders, and the five-level scale used to display progress
 * on each rung.
 *
 * `DesignSpec.md` originally described one ladder for everything. That was
 * wrong for a reason worth stating plainly: **reordering does not make sense
 * for a single verse**. There is nothing to put in order. Equally, matching a
 * reference to its text needs other references to choose between, so it is
 * meaningless for a passage that is the only thing in the collection.
 *
 * So a multi-verse passage always gets `ordering` and a lone verse never
 * does, and the ladders converge afterwards:
 *
 *     multi-verse, siblings: ordering, refmatch -> blanks -> firstletters
 *     multi-verse, alone:    ordering            -> blanks -> firstletters
 *     single verse, siblings:          refmatch -> blanks -> firstletters
 *     single verse, alone:                        blanks -> firstletters
 *
 * The last case is not a rounding error - it is the state of every plan on
 * the day it is created, because the first thing added is always alone.
 *
 * `refmatch` is NOT single-verse-exclusive: it is "match this passage's own
 * text to its own reference", which is exactly as meaningful for a 13-verse
 * passage as for a lone verse, provided there is at least one other passage
 * in the plan to distract with. A multi-verse `refmatch` step still matches
 * at the PASSAGE level - the candidates are whole references (`Session`'s
 * `siblings`/`self`, one row per stored passage, never split by verse) and
 * the text shown is a short preview (the passage's own first verse), never
 * the whole thing and never a per-verse breakdown - see `session.ts`'s
 * `refmatch` case.
 *
 * ## v1: no locks, no promotion
 *
 * The task 0004 review asked for every rung to be practisable at any time -
 * nothing "unlocks", nothing is a warning, and skipping ahead is encouraged
 * rather than merely tolerated. So this file no longer has a promotion
 * threshold or a `CardState`; it has `levelFromScore`, a pure function from
 * "how well did the last attempt go" to a 0-5 display level. `applicableRungs`
 * keeps deciding *which* rungs exist as a property of the material, not of
 * how far the user has come - the round-2 UI review changed WHICH shapes get
 * `refmatch` (see above), not this v1 no-locks premise.
 */

import type { Rung } from './types';

/**
 * How many passages must exist before `refmatch` is worth offering.
 *
 * Two total: the passage itself and at least one other to be confused with. A
 * picker with one option is not an exercise. This applies regardless of how
 * many verses the passage itself spans - see the file header.
 */
const MIN_PASSAGES_FOR_REFMATCH = 2;

/**
 * Which rungs apply to this passage, in ladder order.
 *
 * `siblingCount` is the number of passages in the same collection, including
 * this one - it decides whether `refmatch` has anything to distract with.
 *
 * `ordering` and `refmatch` are independent, not either/or: a multi-verse
 * passage with company in the collection gets both, because a passage
 * needing its own verses ordered may separately need its reference
 * recognised, and neither one substitutes for the other. See the file
 * header on why a lone single verse skips `ordering` entirely.
 *
 * Note this is a function of the *collection*, so it can change under a card:
 * add a second passage and a passage that had `refmatch` alone gains
 * nothing new for itself, but a passage that had none of it now does. That
 * is intentional and is why the ladder is derived on read rather than
 * frozen into rows at add time.
 */
export function applicableRungs(verseCount: number, siblingCount: number): Rung[] {
  const rungs: Rung[] = [];
  if (verseCount > 1) {
    rungs.push('ordering');
  }
  if (siblingCount >= MIN_PASSAGES_FOR_REFMATCH) {
    rungs.push('refmatch');
  }
  rungs.push('blanks', 'firstletters');
  return rungs;
}

/** The rung a newly added passage is suggested to start on. Never null. */
export function firstRungFor(verseCount: number, siblingCount: number): Rung {
  return applicableRungs(verseCount, siblingCount)[0] as Rung;
}

/**
 * Minimum score for an attempt to count as a pass, on the 0..1
 * correct-first-attempts-over-steps scale used by the interval scheduler
 * (`scheduler.ts`).
 *
 * This is a different bar from the level thresholds below: it decides whether
 * an attempt steps the *interval* forward or back, not which level box lights
 * up. 0.8 rather than 1.0 because these exercises are long - a seven-verse
 * ordering is seven chances to fumble one - and demanding perfection would
 * mean a passage that is genuinely known never gets a longer interval.
 */
export const PASS_THRESHOLD = 0.8;

/**
 * The level thresholds, expressed as the minimum score (0..1) that reaches
 * each level.
 *
 * `LEVEL_STRATEGY` below decides which score is fed into this table. The
 * thresholds themselves came out of the task 0004 review and are deliberately
 * a developer-tunable constant rather than a user setting - see the note on
 * `LEVEL_STRATEGY`.
 */
const LEVEL_THRESHOLDS: readonly { min: number; level: number }[] = [
  { min: 1.0, level: 5 },
  { min: 0.9, level: 4 },
  { min: 0.75, level: 3 },
  { min: 0.5, level: 2 },
  { min: 0, level: 1 },
];

/**
 * How a card's displayed level is derived from its attempt history.
 *
 * The task 0004 review asked a question it did not want answered by the user:
 * should a level track only the latest attempt (so it can drop), or the best
 * attempt since the activity was last due? The reply was "make it
 * configurable programmatically, not by user" - i.e. a developer decision that
 * does not belong on the Settings screen. `'latest'` is what v1 ships: it is
 * simple, it is what `Card.lastScore` already stores with no extra
 * bookkeeping, and it is softened in practice by "harder carries down"
 * (`PassageView.bestLevel`), which means a single off day on an easy rung
 * cannot undo a passage's "well learned" status once a harder rung has earned
 * it. Swapping in a best-since-due strategy later means changing this one
 * constant and `levelFromScore`'s caller, not the protocol.
 */
export const LEVEL_STRATEGY: 'latest' = 'latest';

/**
 * The 0-5 level a score maps to, for the plan and passage screens' level
 * boxes.
 *
 * `null` (never attempted) is level 0 - an empty row of boxes, matching the
 * wireframe's "Not tried yet". 100% is its own level (5) rather than folded
 * into "90% or more" (4): the review's own words were "basically perfect",
 * and a user who has just aced a passage should see all five boxes lit, not
 * four with a private asterisk.
 */
export function levelFromScore(score: number | null): number {
  if (score === null) return 0;
  for (const { min, level } of LEVEL_THRESHOLDS) {
    if (score >= min) return level;
  }
  return 0;
}

/** The level at and above which a rung counts as "well learned" (green). */
export const WELL_LEARNED_LEVEL = 4;
