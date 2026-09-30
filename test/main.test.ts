/**
 * Activation wiring.
 *
 * These tests answer one question the unit suites cannot: **does this
 * extension actually attach itself to the host?** Every other test here
 * exercises a function directly. Nothing else checks that `activate` reaches
 * the end, that the panel is registered, or - the expensive one to get wrong -
 * that each `handlerEndpoint` named in `extension.json` is bound to a real
 * function.
 *
 * That last one deserves its own note. A `handlerEndpoint` is a *name*, not a
 * function; a function cannot survive the RPC hop from the worker to the host.
 * The host calls back with that name when the user runs the command, and if
 * nothing bound it, the command still appears in the palette and the Tools
 * menu and silently does nothing. There is no error, no warning, and no way to
 * tell it apart from a handler that ran and had nothing to do. It is the most
 * common mistake in this platform and it is invisible without a test.
 *
 * So the manifest is read from disk rather than restated here. A command added
 * to `extension.json` and never bound fails this file automatically, which is
 * the only version of this test worth having - one with the endpoint names
 * hard-coded would pass forever after the manifest moved on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockApi,
  getMockRuntimeEndpoints,
  getMockPanelChannel,
  MODULE_KJV,
} from '@bible/extension-testing';

import { activate, deactivate } from '../src/main';
import { SqliteHarness } from './sqliteHarness';
import type { PanelRequest, PassageView, PlanView, RungView } from '../src/types';

interface Manifest {
  id: string;
  permissions: string[];
  contributes?: {
    commands?: { id: string; handlerEndpoint: string }[];
    panelTypes?: { id: string }[];
  };
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'extension.json'), 'utf8'),
) as Manifest;

/**
 * `activate` keeps module-level state, and the module is only evaluated once
 * per test file. Re-activating onto a fresh mock is what keeps one test's
 * registrations from being counted by the next.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe('activation', () => {
  it('completes against a mock host', async () => {
    const api = createMockApi();
    await expect(activate(api)).resolves.toBeUndefined();
  });

  it('binds a handler for every command in extension.json', async () => {
    const api = createMockApi();
    await activate(api);

    const bound = getMockRuntimeEndpoints(api).list();
    const declared = (manifest.contributes?.commands ?? []).map((c) => c.handlerEndpoint);

    expect(declared.length).toBeGreaterThan(0);
    for (const endpoint of declared) {
      expect(bound).toContain(endpoint);
    }
  });

  it('registers every declared command with the host registry', async () => {
    // Binding the endpoint is only half of it. Nothing in the host reads
    // `contributes.commands`, so a command that is exposed but never
    // registered exists nowhere the user can reach: not the palette, not the
    // Tools menu, and not as the target of a context-menu item - which then
    // dangles, pointing at an id no registry knows.
    //
    // This extension had exactly that bug: both endpoints bound, neither
    // command registered.
    const register = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ commands: { register } });

    await activate(api);

    const registered = register.mock.calls.map(
      (call) => (call[0] as { id: string }).id,
    );
    for (const command of manifest.contributes?.commands ?? []) {
      expect(registered).toContain(command.id);
    }
  });

  it('gives each registered command the endpoint its manifest declares', async () => {
    // A registration whose `handlerEndpoint` does not match what
    // `runtime.expose` bound invokes nothing, and looks identical to a
    // command that ran and had nothing to do.
    const register = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ commands: { register } });

    await activate(api);

    const byId = new Map(
      register.mock.calls.map((call) => {
        const reg = call[0] as { id: string; handlerEndpoint: string };
        return [reg.id, reg.handlerEndpoint];
      }),
    );
    const bound = getMockRuntimeEndpoints(api).list();

    for (const command of manifest.contributes?.commands ?? []) {
      expect(byId.get(command.id)).toBe(command.handlerEndpoint);
      expect(bound).toContain(command.handlerEndpoint);
    }
  });

  it('declares a command id under its own extension id', async () => {
    // The registry rejects any extension command whose id does not start with
    // `<extensionId>.`, and until recently it built that prefix by prepending
    // a second `ext.` - so a correctly named command was refused and no
    // extension could register one at all. Cheap to assert, and it pins the
    // shape an author has to write.
    for (const command of manifest.contributes?.commands ?? []) {
      expect(command.id.startsWith(`${manifest.id}.`)).toBe(true);
    }
  });

  it('registers its panel type with the short id, not the qualified one', async () => {
    // The host composes the content type as `ext:<extensionId>.<id>`, so
    // passing the fully-qualified id here yields `ext:ext.a.b.ext.a.b.panel`.
    const registerPanelType = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ ui: { registerPanelType } });

    await activate(api);

    expect(registerPanelType).toHaveBeenCalledTimes(1);
    const def = registerPanelType.mock.calls[0]?.[0] as { id: string; uiEntry: string };
    expect(def.id).toBe('panel');
    expect(def.id).not.toContain(manifest.id);
    expect(def.uiEntry).toBe('ui/index.html');
  });

  it('subscribes to active verse changes', async () => {
    const subscribe = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ bible: { onDidChangeActiveVerse: { subscribe } } });

    await activate(api);

    expect(subscribe).toHaveBeenCalled();
  });

  it('contributes a verse context menu item pointing at a bound command', async () => {
    const registerContextMenu = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({ ui: { registerContextMenu } });

    await activate(api);

    expect(registerContextMenu).toHaveBeenCalledWith(
      'verse',
      expect.objectContaining({ command: `${manifest.id}.addActiveVerse` }),
    );

    // The menu item is useless if the command it names is not bound - the item
    // appears, the user clicks it, nothing happens.
    expect(getMockRuntimeEndpoints(api).list()).toContain('addActiveVerse');
  });

  it('deactivates without throwing', () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe('permission failure', () => {
  it('does not throw when storage is refused, and registers nothing', async () => {
    // Only `bible:read` and `commands:register` are auto-granted, and
    // sideloading - which includes "Load unpacked extension" - grants ONLY
    // those regardless of what the manifest declares. So a refused
    // `openDatabase` is the single most likely thing to happen on a first run.
    //
    // Throwing here would have the host report a broken extension, which is
    // misleading: nothing is broken, a permission is simply missing. The
    // extension has to come up inert and say so.
    const registerPanelType = vi.fn().mockResolvedValue({ dispose: vi.fn() });
    const api = createMockApi({
      storage: {
        openDatabase: vi.fn().mockRejectedValue(new Error('PermissionDenied: storage:database')),
      },
      ui: { registerPanelType },
    });

    await expect(activate(api)).resolves.toBeUndefined();
    expect(registerPanelType).not.toHaveBeenCalled();
  });
});

describe('the manifest itself', () => {
  it('declares every permission the code relies on', () => {
    // Drift between what the code calls and what the manifest asks for is
    // silent until a user hits the one code path that needs the missing grant.
    for (const permission of [
      'bible:read',
      'storage:database',
      'ui:contribute-pane',
      'ui:context-menu',
      'ui:status-bar',
      'ui:notification',
      'commands:register',
    ]) {
      expect(manifest.permissions).toContain(permission);
    }
  });
});

/**
 * Mastery, as the panel actually receives it.
 *
 * `buildPlanView`, `isPassageWellLearned` and the `resetPassageProgress`
 * dispatch case are not exported, so these drive them the way the panel does:
 * `activate` against a real `SqliteHarness`, then `getPlan` over the panel
 * channel. Rows are inserted with SQL rather than through `addPassage`,
 * because what is under test is how a *history* is read back, and going
 * through the reference parser and the host's verse ranges to arrange one
 * would put two unrelated subsystems between the fixture and the assertion.
 *
 * Deliberately placed before the `verse labels` block below: its last test
 * permanently downgrades `verseIdEncodingTrusted`, which is module-level state
 * that never comes back.
 */
describe('derived mastery through the panel protocol', () => {
  async function activateWithStore() {
    const db = new SqliteHarness();
    const api = createMockApi({
      storage: { openDatabase: async () => db },
      bible: { listModules: async () => [MODULE_KJV] },
    });
    await activate(api);
    return { db, channel: getMockPanelChannel(api) };
  }

  /** A passage row plus a card for each rung named. */
  async function seedPassage(
    db: SqliteHarness,
    opts: { verseCount: number; reference: string; startVerseId: number; rungs: string[] },
  ): Promise<number> {
    const collection = await db.queryOne<{ id: number }>('SELECT id FROM collection LIMIT 1');
    const res = await db.run(
      `INSERT INTO passage
         (collection_id, module_id, start_verse_id, end_verse_id, reference, verse_count, added_at)
       VALUES (?, 'KJV', ?, ?, ?, ?, 0)`,
      [
        collection?.id,
        opts.startVerseId,
        opts.startVerseId + opts.verseCount - 1,
        opts.reference,
        opts.verseCount,
      ],
    );
    const passageId = Number(res.lastInsertRowid);
    for (const rung of opts.rungs) {
      await db.run(
        `INSERT INTO card (passage_id, rung, state, interval_step, due_at, streak, last_score)
         VALUES (?, ?, 'new', -1, NULL, 0, NULL)`,
        [passageId, rung],
      );
    }
    return passageId;
  }

  async function cardIdFor(db: SqliteHarness, passageId: number, rung: string): Promise<number> {
    const row = await db.queryOne<{ id: number }>(
      `SELECT id FROM card WHERE passage_id = ? AND rung = ?`,
      [passageId, rung],
    );
    return row!.id;
  }

  async function attempt(
    db: SqliteHarness,
    cardId: number,
    opts: { score: number; tier: number; at?: number },
  ): Promise<void> {
    await db.run(
      `INSERT INTO attempt (card_id, at, score, correct_first, total_steps, replay, duration_ms, tier)
       VALUES (?, ?, ?, 1, 1, 0, 1000, ?)`,
      [cardId, opts.at ?? 1_700_000_000_000 + opts.tier, opts.score, opts.tier],
    );
  }

  /** Pass every tier of one activity at `score` - what mastery now takes. */
  async function master(
    db: SqliteHarness,
    passageId: number,
    rung: 'ordering' | 'blanks' | 'firstletters',
    score = 1,
  ): Promise<void> {
    const id = await cardIdFor(db, passageId, rung);
    for (let tier = 0; tier < 2; tier += 1) await attempt(db, id, { score, tier });
  }

  async function getPlan(channel: ReturnType<typeof getMockPanelChannel>): Promise<PlanView> {
    const reply = (await channel.deliver({ type: 'getPlan' })) as {
      ok: boolean;
      data?: PlanView;
      error?: string;
    };
    if (!reply.ok) throw new Error(reply.error);
    return reply.data as PlanView;
  }

  const rungOf = (plan: PlanView, rung: string): RungView =>
    plan.passages[0]!.rungs.find((r) => r.rung === rung) as RungView;

  const TEXT_RUNGS = ['ordering', 'blanks', 'firstletters'];

  it('reports one perfect tier-0 attempt on a two-tier activity as level 3', async () => {
    // The resolved formula's worked example, all the way out to the panel:
    // completeness 1/2 times accuracy 1.0 is 0.5, which is the middle of the
    // 1-5 scale, not the top. Under v1 this same history lit all five boxes.
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: TEXT_RUNGS,
    });
    await attempt(db, await cardIdFor(db, passageId, 'blanks'), { score: 1, tier: 0 });

    const blanks = rungOf(await getPlan(channel), 'blanks');
    expect(blanks.level).toBe(3);
    expect(blanks).toMatchObject({ tiers: 2, tiersPassed: 1, attempts: 1, bestScore: 1 });
    // And the next session should serve the tier that has not been passed.
    expect(blanks.nextTier).toBe(1);
  });

  it('does not lower a level after a bad session, but does bring the due date closer', async () => {
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: TEXT_RUNGS,
    });
    const blanks = await cardIdFor(db, passageId, 'blanks');
    await attempt(db, blanks, { score: 1, tier: 0 });
    // A card a few passes up the ladder, so its interval has room to fall.
    await db.run(`UPDATE card SET interval_step = 3, streak = 3, due_at = ? WHERE id = ?`, [
      2_000_000_000_000,
      blanks,
    ]);
    const before = rungOf(await getPlan(channel), 'blanks');

    await attempt(db, blanks, { score: 0.2, tier: 0, at: 1_800_000_000_000 });
    await db.run(`UPDATE card SET interval_step = 0, streak = 0, due_at = ? WHERE id = ?`, [
      1_800_000_100_000,
      blanks,
    ]);
    const after = rungOf(await getPlan(channel), 'blanks');

    expect(after.level).toBeGreaterThanOrEqual(before.level);
    expect(after.level).toBe(3);
    expect(after.dueAt!).toBeLessThan(before.dueAt!);
    expect(after.attempts).toBe(2);
  });

  it('does NOT call a passage well learned when only its EASIEST activity is mastered', async () => {
    // The direction of "harder carries down", pinned explicitly. `ordering`
    // is first in `TEXT_RECALL_CHAIN`, so mastering it says nothing about
    // `blanks` or `firstletters` - which have never been opened - and the
    // passage is not learned. The old `bestLevel >= 4` rule said it was.
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: TEXT_RUNGS,
    });
    await master(db, passageId, 'ordering');

    const plan = await getPlan(channel);
    expect(rungOf(plan, 'ordering').level).toBe(5);
    expect(rungOf(plan, 'blanks').level).toBe(0);
    expect(plan.passages[0]!.bestLevel).toBe(5);
    expect(plan.passages[0]!.wellLearned).toBe(false);
  });

  it('DOES call it well learned when the HARDEST activity is mastered, without conferring a level', async () => {
    // The other direction, and the distinction the plan is explicit about:
    // `firstletters` carries down to satisfy `blanks` and `ordering`, but
    // those two keep their own level of 0. "Satisfied for the passage's sake"
    // is not "has a score".
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: TEXT_RUNGS,
    });
    await master(db, passageId, 'firstletters');

    const plan = await getPlan(channel);
    expect(plan.passages[0]!.wellLearned).toBe(true);
    expect(rungOf(plan, 'firstletters').level).toBe(5);
    expect(rungOf(plan, 'ordering').level).toBe(0);
    expect(rungOf(plan, 'blanks').level).toBe(0);
    expect(rungOf(plan, 'blanks').attempts).toBe(0);
  });

  it('holds the reference activities inapplicable while the plan is small', async () => {
    // The 25-verse scope gate, read at plan-build time. The cards exist - a
    // history has to have somewhere to live - but neither activity is
    // offered, and neither is counted towards the passage being learned.
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: [...TEXT_RUNGS, 'refmatch', 'refprovide'],
    });
    await master(db, passageId, 'firstletters');

    const plan = await getPlan(channel);
    expect(rungOf(plan, 'refmatch').applicable).toBe(false);
    expect(rungOf(plan, 'refprovide').applicable).toBe(false);
    // Inapplicable activities do not hold the passage back...
    expect(plan.passages[0]!.wellLearned).toBe(true);
    // ...and `refprovide` is single-tier, which the panel needs to know.
    expect(rungOf(plan, 'refprovide').tiers).toBe(1);
  });

  it('applies the reference activities once the plan crosses the scope gate', async () => {
    const { db, channel } = await activateWithStore();
    await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: [...TEXT_RUNGS, 'refmatch', 'refprovide'],
    });
    // A second, long passage takes the whole collection past 25 verses.
    await seedPassage(db, {
      verseCount: 30,
      reference: 'Psalm 119:1-30',
      startVerseId: 19119001,
      rungs: [...TEXT_RUNGS, 'refmatch', 'refprovide'],
    });

    const plan = await getPlan(channel);
    expect(rungOf(plan, 'refmatch').applicable).toBe(true);
    expect(rungOf(plan, 'refprovide').applicable).toBe(true);
    // And they now have to be earned on their own merits - nothing in the
    // text-recall chain carries into them.
    expect(plan.passages[0]!.wellLearned).toBe(false);
  });

  it('resets a passage back to nothing, and answers with the rebuilt plan', async () => {
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: TEXT_RUNGS,
    });
    await master(db, passageId, 'firstletters');
    await db.run(`UPDATE card SET due_at = ?, interval_step = 4, streak = 3 WHERE passage_id = ?`, [
      2_000_000_000_000,
      passageId,
    ]);
    expect((await getPlan(channel)).passages[0]!.wellLearned).toBe(true);

    const reply = (await channel.deliver({ type: 'resetPassageProgress', passageId })) as {
      ok: boolean;
      data?: PlanView;
      error?: string;
    };
    if (!reply.ok) throw new Error(reply.error);

    // The reply carries the new view, so the screen that asked can redraw
    // without waiting for the `planChanged` push to come round.
    const plan = reply.data as PlanView;
    expect(plan.passages[0]!.wellLearned).toBe(false);
    for (const rung of plan.passages[0]!.rungs) {
      expect(rung).toMatchObject({ level: 0, attempts: 0, dueAt: null, streak: 0, bestScore: null });
    }
    expect(plan.totalDue).toBe(0);
    // And the next `getPlan` agrees - the reply was not a one-off view built
    // from something that had not been written.
    expect(await getPlan(channel)).toEqual(plan);
  });

  it('survives a second reset with nothing left to reset', async () => {
    const { db, channel } = await activateWithStore();
    const passageId = await seedPassage(db, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
      rungs: TEXT_RUNGS,
    });
    await master(db, passageId, 'blanks');

    await channel.deliver({ type: 'resetPassageProgress', passageId });
    const second = (await channel.deliver({ type: 'resetPassageProgress', passageId })) as {
      ok: boolean;
      data?: PlanView;
    };

    expect(second.ok).toBe(true);
    expect(second.data?.passages[0]!.rungs.every((r) => r.level === 0)).toBe(true);
  });
});

/**
 * T5: multiple lists and scope, driven the same way the "derived mastery"
 * block above drives the panel protocol - `activate` against a real
 * `SqliteHarness`, then `channel.deliver` for every request. Rows are seeded
 * with SQL rather than `addPassage` for the same reason as that block: what
 * is under test is list management and scope, not reference resolution.
 */
describe('multiple lists through the panel protocol', () => {
  async function activateWithStore() {
    const db = new SqliteHarness();
    const api = createMockApi({
      storage: { openDatabase: async () => db },
      bible: { listModules: async () => [MODULE_KJV] },
    });
    await activate(api);
    return { db, channel: getMockPanelChannel(api) };
  }

  const ALL_RUNGS = ['ordering', 'refmatch', 'blanks', 'firstletters', 'refprovide'];

  /** A passage row plus a card for every rung, in the given list. */
  async function seedPassage(
    db: SqliteHarness,
    collectionId: number,
    opts: { verseCount: number; reference: string; startVerseId: number },
  ): Promise<number> {
    const res = await db.run(
      `INSERT INTO passage
         (collection_id, module_id, start_verse_id, end_verse_id, reference, verse_count, added_at)
       VALUES (?, 'KJV', ?, ?, ?, ?, 0)`,
      [
        collectionId,
        opts.startVerseId,
        opts.startVerseId + opts.verseCount - 1,
        opts.reference,
        opts.verseCount,
      ],
    );
    const passageId = Number(res.lastInsertRowid);
    for (const rung of ALL_RUNGS) {
      await db.run(
        `INSERT INTO card (passage_id, rung, state, interval_step, due_at, streak, last_score)
         VALUES (?, ?, 'new', -1, NULL, 0, NULL)`,
        [passageId, rung],
      );
    }
    return passageId;
  }

  /** Unwrap a channel reply, throwing the worker's own message on failure. */
  async function deliver<T>(
    channel: ReturnType<typeof getMockPanelChannel>,
    req: PanelRequest,
  ): Promise<T> {
    const reply = (await channel.deliver(req)) as { ok: boolean; data?: T; error?: string };
    if (!reply.ok) throw new Error(reply.error);
    return reply.data as T;
  }

  it('creates a list, renames it, and setScope filters the plan to just that list', async () => {
    const { db, channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;

    const created = await deliver<PlanView>(channel, { type: 'createList', name: 'Topical' });
    const secondList = created.lists.find((l) => l.name === 'Topical');
    expect(secondList).toBeDefined();

    await deliver<PlanView>(channel, {
      type: 'renameList',
      id: secondList!.id,
      name: 'Topical verses',
    });

    await seedPassage(db, defaultListId, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
    });
    await seedPassage(db, secondList!.id, {
      verseCount: 1,
      reference: 'John 3:16',
      startVerseId: 43003016,
    });

    const allScope = await deliver<PlanView>(channel, { type: 'getPlan' });
    expect(allScope.passages).toHaveLength(2);
    expect(allScope.scope).toBe('all');

    const scoped = await deliver<PlanView>(channel, {
      type: 'setScope',
      scope: { kind: 'list', id: secondList!.id },
    });
    expect(scoped.passages).toHaveLength(1);
    expect(scoped.passages[0]!.passage.reference).toBe('John 3:16');
    expect(scoped.collectionName).toBe('Topical verses');
    expect(scoped.scope).toBe(secondList!.id);

    // The scope is persisted, so the next `getPlan` (a fresh panel opening,
    // say) still sees just this list without setting scope again.
    expect((await deliver<PlanView>(channel, { type: 'getPlan' })).passages).toHaveLength(1);
  });

  it('refuses to delete the only list, with a readable error rather than a thrown SQL failure', async () => {
    const { channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });

    const reply = (await channel.deliver({
      type: 'deleteList',
      id: plan.collectionId,
      movePassagesTo: plan.collectionId,
    })) as { ok: boolean; error?: string };

    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/only list/i);
  });

  it('moves passages, cards AND attempt history to the target list when a list is deleted', async () => {
    const { db, channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;

    const created = await deliver<PlanView>(channel, { type: 'createList', name: 'Temp' });
    const tempList = created.lists.find((l) => l.name === 'Temp')!;

    const passageId = await seedPassage(db, tempList.id, {
      verseCount: 1,
      reference: 'John 3:16',
      startVerseId: 43003016,
    });
    const blanksCard = await db.queryOne<{ id: number }>(
      `SELECT id FROM card WHERE passage_id = ? AND rung = 'blanks'`,
      [passageId],
    );
    await db.run(
      `INSERT INTO attempt (card_id, at, score, correct_first, total_steps, replay, duration_ms, tier)
       VALUES (?, ?, 1, 1, 1, 0, 1000, 0)`,
      [blanksCard!.id, 1_700_000_000_000],
    );

    const afterDelete = await deliver<PlanView>(channel, {
      type: 'deleteList',
      id: tempList.id,
      movePassagesTo: defaultListId,
    });

    const moved = afterDelete.passages.find((p) => p.passage.id === passageId);
    expect(moved?.passage.reference).toBe('John 3:16');
    expect(moved?.passage.collectionId).toBe(defaultListId);

    const attemptRows = await db.query(`SELECT * FROM attempt WHERE card_id = ?`, [blanksCard!.id]);
    expect(attemptRows).toHaveLength(1);

    expect(afterDelete.lists.find((l) => l.id === tempList.id)).toBeUndefined();
  });

  it('falls back to scope "all" once the scoped list is deleted out from under the panel', async () => {
    const { channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;

    const created = await deliver<PlanView>(channel, { type: 'createList', name: 'Temp' });
    const tempList = created.lists.find((l) => l.name === 'Temp')!;

    const scoped = await deliver<PlanView>(channel, {
      type: 'setScope',
      scope: { kind: 'list', id: tempList.id },
    });
    expect(scoped.scope).toBe(tempList.id);

    // Simulated as if a different call path deleted the scoped list.
    await deliver<PlanView>(channel, {
      type: 'deleteList',
      id: tempList.id,
      movePassagesTo: defaultListId,
    });

    const after = await deliver<PlanView>(channel, { type: 'getPlan' });
    expect(after.scope).toBe('all');
  });

  it('the same reference in two lists is two independent passage rows with independent progress', async () => {
    const { db, channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;

    const created = await deliver<PlanView>(channel, { type: 'createList', name: 'Second' });
    const secondList = created.lists.find((l) => l.name === 'Second')!;

    const a = await seedPassage(db, defaultListId, {
      verseCount: 1,
      reference: 'John 3:16',
      startVerseId: 43003016,
    });
    const b = await seedPassage(db, secondList.id, {
      verseCount: 1,
      reference: 'John 3:16',
      startVerseId: 43003016,
    });
    expect(a).not.toBe(b);

    const allScope = await deliver<PlanView>(channel, { type: 'getPlan' });
    const rows = allScope.passages.filter((p) => p.passage.reference === 'John 3:16');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.passage.collectionId))).toEqual(
      new Set([defaultListId, secondList.id]),
    );
  });

  it('sums verses, not passage rows, in scopeVerseCount and lists[].verseCount', async () => {
    const { db, channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;

    await seedPassage(db, defaultListId, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
    });
    await seedPassage(db, defaultListId, {
      verseCount: 1,
      reference: 'John 3:16',
      startVerseId: 43003016,
    });

    const after = await deliver<PlanView>(channel, { type: 'getPlan' });
    expect(after.scopeVerseCount).toBe(4);
    expect(after.lists.find((l) => l.id === defaultListId)?.verseCount).toBe(4);
  });

  it('moves a passage to another list through the protocol', async () => {
    const { db, channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;

    const created = await deliver<PlanView>(channel, { type: 'createList', name: 'Second' });
    const secondList = created.lists.find((l) => l.name === 'Second')!;
    const passageId = await seedPassage(db, defaultListId, {
      verseCount: 1,
      reference: 'John 3:16',
      startVerseId: 43003016,
    });

    const after = await deliver<PlanView>(channel, {
      type: 'movePassage',
      passageId,
      collectionId: secondList.id,
    });
    const movedRow = after.passages.find((p) => p.passage.id === passageId);
    expect(movedRow?.passage.collectionId).toBe(secondList.id);
  });

  it('answers getPassageView for one passage without requiring the whole plan', async () => {
    const { db, channel } = await activateWithStore();
    const plan = await deliver<PlanView>(channel, { type: 'getPlan' });
    const defaultListId = plan.collectionId;
    const passageId = await seedPassage(db, defaultListId, {
      verseCount: 3,
      reference: 'Psalm 23:1-3',
      startVerseId: 19023001,
    });

    const view = await deliver<PassageView>(channel, { type: 'getPassageView', passageId });
    expect(view.passage.id).toBe(passageId);
    expect(view.rungs.map((r) => r.rung).sort()).toEqual([...ALL_RUNGS].sort());
  });
});

/**
 * Verse labels: "3:16" vs bare "16" in the margin.
 *
 * `labelFor`/the labeller factory are not exported, so these drive the real
 * thing through `activate` + the panel protocol, exactly as the panel does:
 * `getContext` (`buildContext`) and `startSession` (its own `fetchVerses`
 * call). A real `SqliteHarness` backs storage so `store.getPassage` and
 * `store.getCard` see real rows, not the inert defaults `createMockApi`'s own
 * in-memory database mock returns.
 *
 * `bible.getRange` is backed by a small id -> text map per test rather than a
 * filled-in contiguous range: the verse id encoding jumps by 1000 at every
 * chapter boundary regardless of how many verses the chapter actually has, so
 * "fill every integer between start and end" would manufacture thousands of
 * nonexistent verses for a range that crosses a chapter. A real host never
 * returns an id nothing was asked to invent, and neither does this mock.
 */
describe('verse labels', () => {
  const JOHN = 43;
  const GENESIS = 1;

  function verseId(book: number, chapter: number, verse: number): number {
    return book * 1_000_000 + chapter * 1_000 + verse;
  }

  function dto(id: number): { verseId: number; text: string; textPlain: string } {
    const text = `Verse text for ${id}.`;
    return { verseId: id, text, textPlain: text };
  }

  /** `bible.getRange` that only knows about the ids named in `known`. */
  function getRangeOf(known: number[]) {
    const byId = new Map(known.map((id) => [id, dto(id)]));
    return async (start: number, end: number) =>
      known
        .filter((id) => id >= start && id <= end)
        .sort((a, b) => a - b)
        .map((id) => byId.get(id));
  }

  /**
   * Activate against a real (in-memory) sqlite-backed store, with `getRange`
   * limited to `knownVerseIds` and the encoding check passing (John's chapter
   * 3 fixture matches the expected `firstVerseId`, so `verseIdEncodingTrusted`
   * stays `true` unless a test overrides `listChapters`).
   */
  async function activateForLabels(knownVerseIds: number[], apiOverrides: Record<string, unknown> = {}) {
    const db = new SqliteHarness();
    const api = createMockApi({
      storage: { openDatabase: async () => db },
      bible: {
        listModules: async () => [MODULE_KJV],
        getRange: getRangeOf(knownVerseIds),
      },
      ...apiOverrides,
    });
    await activate(api);
    return { api, db, channel: getMockPanelChannel(api) };
  }

  /** Insert a passage row directly, bypassing `addPassage`'s reference parser
   * and its `MAX_PASSAGE_VERSES` cap - which is computed as a raw
   * `endVerseId - startVerseId` difference and so cannot represent a real
   * cross-chapter passage (the 1000-per-chapter gap dwarfs it). That cap is
   * unrelated to what is under test here: how `buildContext`/`startSession`
   * label whatever passage the store already holds. */
  async function insertPassage(
    db: SqliteHarness,
    over: { startVerseId: number; endVerseId: number; reference: string; verseCount: number },
  ): Promise<number> {
    const collection = await db.queryOne<{ id: number }>('SELECT id FROM collection LIMIT 1');
    const res = await db.run(
      `INSERT INTO passage
         (collection_id, module_id, start_verse_id, end_verse_id, reference, verse_count, added_at)
       VALUES (?, 'KJV', ?, ?, ?, ?, 0)`,
      [collection?.id, over.startVerseId, over.endVerseId, over.reference, over.verseCount],
    );
    return Number(res.lastInsertRowid);
  }

  async function getContext(channel: ReturnType<typeof getMockPanelChannel>, passageId: number) {
    const reply = (await channel.deliver({ type: 'getContext', passageId })) as {
      ok: boolean;
      data?: { before: { label: string }[]; verses: { label: string }[]; after: { label: string }[] };
      error?: string;
    };
    if (!reply.ok) throw new Error(reply.error);
    return reply.data as { before: { label: string }[]; verses: { label: string }[]; after: { label: string }[] };
  }

  it('renders bare verse numbers for a single-chapter passage, in the passage and its context', async () => {
    const start = verseId(GENESIS, 1, 14);
    const end = verseId(GENESIS, 1, 16);
    const known = [11, 12, 13, 14, 15, 16, 17, 18, 19].map((v) => verseId(GENESIS, 1, v));
    const { db, channel } = await activateForLabels(known);
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'Genesis 1:14-16',
      verseCount: 3,
    });

    const ctx = await getContext(channel, passageId);

    expect(ctx.verses.map((v) => v.label)).toEqual(['14', '15', '16']);
    expect(ctx.before.map((v) => v.label)).toEqual(['11', '12', '13']);
    expect(ctx.after.map((v) => v.label)).toEqual(['17', '18', '19']);
  });

  it('sanity-checks the boundary: a passage starting at verse 1 still renders bare', async () => {
    const start = verseId(GENESIS, 1, 1);
    const end = verseId(GENESIS, 1, 2);
    const known = [1, 2, 3].map((v) => verseId(GENESIS, 1, v));
    const { db, channel } = await activateForLabels(known);
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'Genesis 1:1-2',
      verseCount: 2,
    });

    const ctx = await getContext(channel, passageId);

    expect(ctx.verses.map((v) => v.label)).toEqual(['1', '2']);
  });

  it('renders chapter:verse throughout a passage spanning chapters', async () => {
    const start = verseId(JOHN, 3, 35);
    const end = verseId(JOHN, 4, 2);
    const known = [verseId(JOHN, 3, 35), verseId(JOHN, 3, 36), verseId(JOHN, 4, 1), verseId(JOHN, 4, 2)];
    const { db, channel } = await activateForLabels(known);
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'John 3:35-4:2',
      verseCount: 4,
    });

    const ctx = await getContext(channel, passageId);

    expect(ctx.verses.map((v) => v.label)).toEqual(['3:35', '3:36', '4:1', '4:2']);
  });

  it('labels context verses from the chapter before a single-chapter passage as chapter:verse, not bare', async () => {
    // The key correctness case: a passage confined to chapter 3 must not make
    // a chapter-2 context verse read as if it belonged to chapter 3.
    const start = verseId(JOHN, 3, 1);
    const end = verseId(JOHN, 3, 3);
    const before = [verseId(JOHN, 2, 998), verseId(JOHN, 2, 999)];
    const { db, channel } = await activateForLabels([...before, start, start + 1, end]);
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'John 3:1-3',
      verseCount: 3,
    });

    const ctx = await getContext(channel, passageId);

    expect(ctx.verses.map((v) => v.label)).toEqual(['1', '2', '3']);
    expect(ctx.before.map((v) => v.label)).toEqual(['2:998', '2:999']);
  });

  it('labels context verses from the chapter after a single-chapter passage as chapter:verse, not bare', async () => {
    // Same case, the other direction: the passage's own tail verse is bare,
    // but the moment context crosses into chapter 4 it must read "4:1".
    const start = verseId(JOHN, 3, 990);
    const end = verseId(JOHN, 3, 998);
    const after = [verseId(JOHN, 3, 999), verseId(JOHN, 4, 1)];
    const { db, channel } = await activateForLabels([start, end, ...after]);
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'John 3:990-998',
      verseCount: 9,
    });

    const ctx = await getContext(channel, passageId);

    expect(ctx.verses[ctx.verses.length - 1]?.label).toBe('998');
    expect(ctx.after.map((v) => v.label)).toEqual(['999', '4:1']);
  });

  it('uses the same chapter:verse labelling in startSession as in getContext', async () => {
    const start = verseId(JOHN, 3, 35);
    const end = verseId(JOHN, 4, 2);
    const known = [verseId(JOHN, 3, 35), verseId(JOHN, 3, 36), verseId(JOHN, 4, 1), verseId(JOHN, 4, 2)];
    const { db, channel } = await activateForLabels(known);
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'John 3:35-4:2',
      verseCount: 4,
    });

    // `startSession` requires a card row for the rung it is asked to start -
    // normally created by `syncLadders` inside `addPassage`, which
    // `insertPassage` bypasses along with the reference parser.
    await db.run(
      `INSERT INTO card (passage_id, rung, state, interval_step, due_at, streak, last_score)
       VALUES (?, 'blanks', 'new', -1, NULL, 0, NULL)`,
      [passageId],
    );

    const reply = (await channel.deliver({
      type: 'startSession',
      passageId,
      rung: 'blanks',
      restart: false,
    })) as { ok: boolean; data?: { step: { verses: { label: string }[] } }; error?: string };

    if (!reply.ok) throw new Error(reply.error);
    // Cursor starts at 0: the first verse of the passage, chapter 3.
    expect(reply.data?.step.verses[0]?.label).toBe('3:35');
  });

  // Kept last in this file: `verseIdEncodingTrusted` is module-level state
  // that `verifyVerseIdEncoding` only ever downgrades to `false`, never back
  // to `true`, so any test after this one would inherit the downgrade.
  it('falls back to raw ids everywhere when the verse id encoding is not trusted', async () => {
    const start = verseId(JOHN, 3, 35);
    const end = verseId(JOHN, 4, 2);
    const known = [verseId(JOHN, 3, 35), verseId(JOHN, 3, 36), verseId(JOHN, 4, 1), verseId(JOHN, 4, 2)];
    // A `listChapters` answer that does not match the expected
    // `book*1e6 + chapter*1e3 + 1` shape flips `verseIdEncodingTrusted` to
    // false at activation - the same "downgrade rather than show a wrong
    // label" path `verifyVerseIdEncoding` takes in production.
    const { db, channel } = await activateForLabels(known, {
      bible: {
        listModules: async () => [MODULE_KJV],
        getRange: getRangeOf(known),
        listChapters: async (bookNumber: number) =>
          bookNumber === JOHN ? [{ chapter: 3, firstVerseId: 999, lastVerseId: 999, verseCount: 1 }] : [],
      },
    });
    const passageId = await insertPassage(db, {
      startVerseId: start,
      endVerseId: end,
      reference: 'John 3:35-4:2',
      verseCount: 4,
    });

    const ctx = await getContext(channel, passageId);

    expect(ctx.verses.map((v) => v.label)).toEqual([String(start), String(start + 1), String(end - 1), String(end)]);
  });
});
