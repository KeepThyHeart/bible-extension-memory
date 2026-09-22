/**
 * Ladder-shape and level tests.
 *
 * The single fact the `applicableRungs` block exists to protect is that
 * `ordering` and `refmatch` are two INDEPENDENT first rungs, not one ladder
 * with a single opening move, and which ones apply is a property of the
 * *material* rather than of the user: `ordering` needs more than one verse,
 * `refmatch` needs another passage in the plan to be confused with, and a
 * multi-verse passage with company gets both. A regression back to treating
 * them as either/or would not throw anywhere - it would simply stop offering
 * a multi-verse passage its own reference-matching exercise, silently. So the
 * shape is asserted directly rather than inferred from anything downstream.
 *
 * The case that gets the most attention below is the third one - a single
 * verse ALONE in the collection, which starts at `blanks` because neither
 * first rung is possible. That is not an exotic edge case: it is the state of
 * every plan on the day it is created, because the first passage a user adds
 * is necessarily the only passage. A `firstRungFor` that returned `refmatch`
 * unconditionally for single verses would break the very first thing every
 * user of this extension ever does, and would do it silently, by handing them
 * a picker with one option.
 *
 * The `levelFromScore` block replaced what used to be `shouldPromote` /
 * `cardStateFor` - task 0004 dropped locks and promotion entirely in favour of
 * a five-level display derived straight from the last score.
 */

import { describe, it, expect } from 'vitest';
import { applicableRungs, firstRungFor, levelFromScore, WELL_LEARNED_LEVEL } from '../src/ladder';
import { RUNG_ORDER } from '../src/types';
import type { Rung } from '../src/types';

describe('applicableRungs - which ladder this material is on', () => {
  it('puts a multi-verse passage on the ordering ladder regardless of siblings', () => {
    // "Which verse comes next" is the cheapest test of the thing that breaks
    // first in a half-learned passage: not the words, the ORDER. Any passage
    // with more than one verse has an order, so it gets that rung regardless
    // of how many siblings it has.
    expect(applicableRungs(3, 1)).toEqual(['ordering', 'blanks', 'firstletters']);
  });

  it('adds refmatch alongside ordering once there is something to confuse the reference with', () => {
    // `ordering` and `refmatch` are independent, not either/or - a multi-verse
    // passage with company in the plan gets both, because needing its own
    // verses ordered and needing its reference recognised are two different
    // things neither substitutes for.
    expect(applicableRungs(3, 5)).toEqual(['ordering', 'refmatch', 'blanks', 'firstletters']);
  });

  it('puts a single verse with siblings on the refmatch ladder', () => {
    // A lone verse has no internal order, but it can be confused with the
    // other references in the plan - so the first rung becomes "which
    // reference is this?". Two passages is the minimum: the verse itself plus
    // one thing to be confused with.
    expect(applicableRungs(1, 2)).toEqual(['refmatch', 'blanks', 'firstletters']);
    expect(applicableRungs(1, 9)).toEqual(['refmatch', 'blanks', 'firstletters']);
  });

  it('offers refmatch for a multi-verse passage too, matched as one passage-reference unit', () => {
    // A 13-verse passage's `refmatch` step is exactly as meaningful as a lone
    // verse's: match this passage's own text (a short preview) to its own
    // whole-passage reference, never a per-verse breakdown - see
    // `session.ts`'s `refmatch` case and `types.ts#RefMatchStep`.
    expect(applicableRungs(13, 2)).toContain('refmatch');
    expect(applicableRungs(13, 1)).not.toContain('refmatch');
  });

  it('gives a single verse ALONE in the collection neither first rung', () => {
    // The state of every plan on day one. Reordering one verse is meaningless
    // and a reference picker needs distractors, so both first rungs are
    // genuinely impossible and the ladder starts at `blanks`. A regression
    // that emitted `refmatch` here would hand the very first user of the very
    // first passage a one-option picker.
    expect(applicableRungs(1, 1)).toEqual(['blanks', 'firstletters']);
    // A collection that somehow reports zero siblings (a passage read back
    // mid-delete, say) must degrade the same way rather than throwing.
    expect(applicableRungs(1, 0)).toEqual(['blanks', 'firstletters']);
  });

  it('never emits a rung out of canonical order, on any ladder', () => {
    // `RUNG_ORDER` is what the passage screen and `nextDueCard`'s CASE
    // expression both key off. If `applicableRungs` ever returned its rungs in
    // a different relative order the two would silently disagree about which
    // rung comes next, so the invariant is pinned here rather than trusted.
    const shapes: [number, number][] = [
      [1, 1],
      [1, 2],
      [2, 1],
      [7, 4],
    ];
    for (const [verses, siblings] of shapes) {
      const rungs = applicableRungs(verses, siblings);
      const positions = rungs.map((r) => RUNG_ORDER.indexOf(r));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    }
  });

  it('always includes the two shared rungs, so a ladder is never empty', () => {
    // `firstRungFor` is documented as "never null" and its callers rely on
    // that - `syncLadders` indexes `wanted[0]` without a guard. The guarantee
    // comes from `blanks` and `firstletters` applying unconditionally.
    for (const verses of [1, 2, 50]) {
      for (const siblings of [0, 1, 2, 20]) {
        const rungs = applicableRungs(verses, siblings);
        expect(rungs).toContain('blanks');
        expect(rungs).toContain('firstletters');
      }
    }
  });
});

describe('firstRungFor', () => {
  it('agrees with the head of applicableRungs for every shape', () => {
    // These are two entry points onto the same fact, and `store.syncLadders`
    // uses the array form while `main.ts` uses the scalar one. Letting them
    // drift would mean a card inserted at one rung while the plan view showed
    // the ladder starting at another.
    const shapes: [number, number][] = [
      [1, 1],
      [1, 2],
      [4, 1],
      [4, 6],
    ];
    for (const [verses, siblings] of shapes) {
      expect(firstRungFor(verses, siblings)).toBe(applicableRungs(verses, siblings)[0]);
    }
  });

  it('starts a brand new plan on blanks', () => {
    expect(firstRungFor(1, 1)).toBe('blanks');
  });
});

describe('levelFromScore', () => {
  it('is 0 for a card that has never been attempted', () => {
    // `null` is "never tried", which the plan and passage screens draw as an
    // empty row of boxes - not level 1, which would look like a failed try.
    expect(levelFromScore(null)).toBe(0);
  });

  it('reaches every level at its documented threshold', () => {
    expect(levelFromScore(1)).toBe(5);
    expect(levelFromScore(0.9)).toBe(4);
    expect(levelFromScore(0.75)).toBe(3);
    expect(levelFromScore(0.5)).toBe(2);
    expect(levelFromScore(0.01)).toBe(1);
  });

  it('treats each threshold as inclusive, not as a value to beat', () => {
    // A user who reaches exactly 90% should see level 4 lit, not be one point
    // short of it - these are the boundaries the level boxes are drawn from,
    // and an off-by-one here reads as "so close" for no reason.
    expect(levelFromScore(0.899999)).toBe(3);
    expect(levelFromScore(0.9)).toBe(4);
    expect(levelFromScore(0.999999)).toBe(4);
    expect(levelFromScore(1)).toBe(5);
  });

  it('never goes below level 1 once any attempt has been made', () => {
    // Level 0 is reserved for "never tried" (see above). A very poor score
    // still reflects an attempt and should not be indistinguishable from one.
    expect(levelFromScore(0)).toBe(1);
  });

  it('agrees with WELL_LEARNED_LEVEL at the green boundary', () => {
    expect(levelFromScore(0.9)).toBe(WELL_LEARNED_LEVEL);
    expect(levelFromScore(0.89)).toBeLessThan(WELL_LEARNED_LEVEL);
  });
});

describe('the two ladders converge', () => {
  it('shares its last two rungs across every shape of material', () => {
    // Stated as its own assertion because it is the design claim the whole
    // module is organised around: the first rung differs, everything after it
    // does not. An exercise added to only one ladder would break this.
    const tails = new Set<string>();
    const shapes: [number, number][] = [
      [1, 1],
      [1, 3],
      [5, 1],
      [5, 3],
    ];
    for (const [verses, siblings] of shapes) {
      const rungs: Rung[] = applicableRungs(verses, siblings);
      tails.add(rungs.slice(-2).join('>'));
    }
    expect([...tails]).toEqual(['blanks>firstletters']);
  });
});
