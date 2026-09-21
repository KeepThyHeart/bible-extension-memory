/**
 * Tests for `src/ui/suggest.ts` - the shuffle's weighted draw and the
 * "start this specific activity" picker.
 *
 * Fixtures mirror the style in `test/panelRender.test.ts`
 * (`rungView`/`passageViewFixture`), updated for the current `PlanView`
 * shape (T5's `lists`/`scope`/`scopeVerseCount`/`referenceActivitiesUnlocked`
 * and T4's per-rung tier fields).
 */

import { describe, it, expect } from 'vitest';
import { listTargets, pickShuffledTarget, pickTargetForActivity } from '../src/ui/suggest';
import { mulberry32 } from '../src/exercises/rng';
import type { Passage, PassageView, PlanView, RungView } from '../src/types';

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

function rungView(over: Partial<RungView> & Pick<RungView, 'rung'>): RungView {
  return {
    level: 0,
    dueAt: null,
    streak: 0,
    lastScore: null,
    applicable: true,
    resume: null,
    tiers: 2,
    tiersPassed: 0,
    bestScore: null,
    attempts: 0,
    nextTier: 0,
    ...over,
  };
}

function passageFixture(over: Partial<Passage> = {}): Passage {
  return {
    id: 10,
    collectionId: 1,
    moduleId: 'kjv',
    startVerseId: 19023001,
    endVerseId: 19023006,
    reference: 'Psalm 23:1-6',
    verseCount: 6,
    addedAt: NOW - 30 * 86_400_000,
    answerMode: null,
    ...over,
  };
}

function passageViewFixture(over: Partial<PassageView> = {}): PassageView {
  return {
    passage: passageFixture(),
    dueCount: 0,
    bestLevel: 0,
    wellLearned: false,
    rungs: [
      rungView({ rung: 'ordering', level: 3 }),
      rungView({ rung: 'refmatch', applicable: false }),
      rungView({ rung: 'blanks', level: 1, dueAt: NOW - 60_000 }),
      rungView({ rung: 'firstletters' }),
    ],
    ...over,
  };
}

function planFixture(passages: PassageView[]): PlanView {
  return {
    collectionId: 1,
    collectionName: 'Default',
    lists: [{ id: 1, name: 'Default', passageCount: passages.length, verseCount: 0 }],
    scope: 'all',
    scopeVerseCount: 0,
    referenceActivitiesUnlocked: true,
    passages,
    totalDue: passages.reduce((n, pv) => n + pv.dueCount, 0),
    defaultAnswerMode: 'firstLetter',
  };
}

function emptyPlan(): PlanView {
  return planFixture([]);
}

// ---------------------------------------------------------------------------
// listTargets
// ---------------------------------------------------------------------------

describe('listTargets', () => {
  it('returns [] for an empty plan', () => {
    expect(listTargets(emptyPlan(), NOW)).toEqual([]);
  });

  it('excludes inapplicable rungs', () => {
    const plan = planFixture([passageViewFixture()]);
    const targets = listTargets(plan, NOW);
    // Fixture marks `refmatch` inapplicable.
    expect(targets.some((t) => t.rung === 'refmatch')).toBe(false);
    expect(targets.map((t) => t.rung).sort()).toEqual(['blanks', 'firstletters', 'ordering']);
  });

  it('flags due correctly from dueAt vs now', () => {
    const plan = planFixture([passageViewFixture()]);
    const targets = listTargets(plan, NOW);
    const blanks = targets.find((t) => t.rung === 'blanks')!;
    const ordering = targets.find((t) => t.rung === 'ordering')!;
    expect(blanks.due).toBe(true); // dueAt in the past
    expect(ordering.due).toBe(false); // dueAt null -> never due
  });

  it('carries passageId, reference and level through', () => {
    const plan = planFixture([passageViewFixture()]);
    const targets = listTargets(plan, NOW);
    const ordering = targets.find((t) => t.rung === 'ordering')!;
    expect(ordering.passageId).toBe(10);
    expect(ordering.reference).toBe('Psalm 23:1-6');
    expect(ordering.level).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// pickShuffledTarget - edge cases
// ---------------------------------------------------------------------------

describe('pickShuffledTarget edge cases', () => {
  it('returns null for an empty plan, never throws', () => {
    const rng = mulberry32(1);
    expect(pickShuffledTarget(emptyPlan(), NOW, rng)).toBeNull();
  });

  it('returns the sole target even when it is excluded', () => {
    const plan = planFixture([
      passageViewFixture({
        rungs: [rungView({ rung: 'ordering', level: 0 })],
      }),
    ]);
    const rng = mulberry32(1);
    const only = listTargets(plan, NOW)[0]!;
    const result = pickShuffledTarget(plan, NOW, rng, only);
    expect(result).not.toBeNull();
    expect(result!.passageId).toBe(only.passageId);
    expect(result!.rung).toBe(only.rung);
  });

  it('never returns an inapplicable rung across many draws', () => {
    const plan = planFixture([passageViewFixture()]);
    const rng = mulberry32(42);
    for (let i = 0; i < 500; i += 1) {
      const t = pickShuffledTarget(plan, NOW, rng);
      expect(t).not.toBeNull();
      expect(t!.rung).not.toBe('refmatch');
    }
  });

  it('when every applicable target is due, only ever returns due targets', () => {
    const plan = planFixture([
      passageViewFixture({
        rungs: [
          rungView({ rung: 'ordering', dueAt: NOW - 1000 }),
          rungView({ rung: 'blanks', dueAt: NOW - 2000 }),
          rungView({ rung: 'firstletters', dueAt: NOW - 3000 }),
        ],
      }),
    ]);
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i += 1) {
      const t = pickShuffledTarget(plan, NOW, rng);
      expect(t).not.toBeNull();
      expect(t!.due).toBe(true);
    }
  });

  it('handles an rng that always returns exactly 0', () => {
    const plan = planFixture([passageViewFixture()]);
    const rng = () => 0;
    const t = pickShuffledTarget(plan, NOW, rng);
    expect(t).not.toBeNull();
    expect(['ordering', 'blanks', 'firstletters']).toContain(t!.rung);
  });

  it('handles an rng that always returns just under 1', () => {
    const plan = planFixture([passageViewFixture()]);
    const rng = () => 0.9999999999;
    const t = pickShuffledTarget(plan, NOW, rng);
    expect(t).not.toBeNull();
    expect(['ordering', 'blanks', 'firstletters']).toContain(t!.rung);
  });

  it('falls back to the full applicable set when excluding empties the chosen pool but not the whole plan', () => {
    // Only one due target; exclude it. The due pool would be empty after
    // exclusion, but two other applicable (non-due) targets exist.
    const plan = planFixture([
      passageViewFixture({
        rungs: [
          rungView({ rung: 'ordering', dueAt: NOW - 1000 }), // only due one
          rungView({ rung: 'blanks', dueAt: null }),
          rungView({ rung: 'firstletters', dueAt: null }),
        ],
      }),
    ]);
    const excluded = listTargets(plan, NOW).find((t) => t.rung === 'ordering')!;
    // Force the due branch every time (rng() < 0.3) then a deterministic index.
    let call = 0;
    const rng = () => (call++ === 0 ? 0.0 : 0.0);
    const result = pickShuffledTarget(plan, NOW, rng, excluded);
    expect(result).not.toBeNull();
    expect(result!.rung).not.toBe('ordering');
  });
});

// ---------------------------------------------------------------------------
// pickShuffledTarget - distribution
// ---------------------------------------------------------------------------

describe('pickShuffledTarget distribution', () => {
  it('picks from the due pool ~30% of the time over 1000 draws with a fixed seed', () => {
    // 30 passages, one applicable (non-due) rung each, except passage 1's
    // rung, which is due. With only 1 due target among 30 total, the 70%
    // "general pool" branch has only a ~3% chance of landing on the due one
    // by coincidence, so the overall due-hit rate closely tracks the 30%
    // branch-selection rate itself (0.30 + 0.70/30 ~= 0.323) rather than
    // being inflated by overlap between the two pools.
    const passages: PassageView[] = [];
    for (let id = 1; id <= 30; id += 1) {
      passages.push(
        passageViewFixture({
          passage: passageFixture({ id }),
          rungs: [rungView({ rung: 'ordering', dueAt: id === 1 ? NOW - 1000 : null })],
        }),
      );
    }
    const plan = planFixture(passages);

    const rng = mulberry32(1234);
    const N = 1000;
    let dueHits = 0;
    for (let i = 0; i < N; i += 1) {
      const t = pickShuffledTarget(plan, NOW, rng)!;
      if (t.due) dueHits += 1;
    }
    const rate = dueHits / N;
    expect(rate).toBeGreaterThan(0.25);
    expect(rate).toBeLessThan(0.38);
  });
});

// ---------------------------------------------------------------------------
// pickTargetForActivity
// ---------------------------------------------------------------------------

describe('pickTargetForActivity', () => {
  it('returns null for an empty plan', () => {
    expect(pickTargetForActivity(emptyPlan(), 'blanks', NOW)).toBeNull();
  });

  it('returns null when the rung is not applicable anywhere', () => {
    const plan = planFixture([passageViewFixture()]); // refmatch is inapplicable
    expect(pickTargetForActivity(plan, 'refmatch', NOW)).toBeNull();
  });

  it('prefers a due target over a non-due one for the same rung', () => {
    const plan = planFixture([
      passageViewFixture({
        passage: passageFixture({ id: 1 }),
        rungs: [rungView({ rung: 'blanks', dueAt: null })],
      }),
      passageViewFixture({
        passage: passageFixture({ id: 2 }),
        rungs: [rungView({ rung: 'blanks', dueAt: NOW - 5000 })],
      }),
    ]);
    const t = pickTargetForActivity(plan, 'blanks', NOW);
    expect(t).not.toBeNull();
    expect(t!.passageId).toBe(2);
    expect(t!.due).toBe(true);
  });

  it('breaks ties on the soonest due date, then lowest passageId', () => {
    const plan = planFixture([
      passageViewFixture({
        passage: passageFixture({ id: 5 }),
        rungs: [rungView({ rung: 'blanks', dueAt: NOW - 1000 })],
      }),
      passageViewFixture({
        passage: passageFixture({ id: 2 }),
        rungs: [rungView({ rung: 'blanks', dueAt: NOW - 9000 })], // longer overdue
      }),
    ]);
    const t = pickTargetForActivity(plan, 'blanks', NOW);
    expect(t!.passageId).toBe(2);
  });

  it('falls back to the lowest passageId when nothing is due', () => {
    const plan = planFixture([
      passageViewFixture({
        passage: passageFixture({ id: 8 }),
        rungs: [rungView({ rung: 'blanks', dueAt: null })],
      }),
      passageViewFixture({
        passage: passageFixture({ id: 3 }),
        rungs: [rungView({ rung: 'blanks', dueAt: null })],
      }),
    ]);
    const t = pickTargetForActivity(plan, 'blanks', NOW);
    expect(t!.passageId).toBe(3);
  });
});
