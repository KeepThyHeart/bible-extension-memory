/**
 * Recite aloud through the worker: `activate` against a real sqlite store and a
 * FakeSpeechApi, driven over the panel channel exactly as the panel does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockApi, getMockPanelChannel, getMockRuntimeEndpoints, MODULE_KJV } from '@bible/extension-testing';
import { FakeSpeechApi } from '@bible/core/speech';
import type { ScriptItem } from '@bible/core/speech';

import { activate, deactivate } from '../src/main';
import { SqliteHarness } from './sqliteHarness';
import type { PassageView, PlanView, ReciteStateView, SettingsView } from '../src/types';

const JOHN_3_16 = 43003016;
const TEXT =
  'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.';
const SENTINEL = 'xylophonequartz';

beforeEach(() => {
  vi.clearAllMocks();
});

type Channel = ReturnType<typeof getMockPanelChannel>;

async function call<T>(channel: Channel, req: Record<string, unknown>): Promise<T> {
  const reply = (await channel.deliver(req)) as { ok: boolean; data?: T; error?: string };
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as T;
}

async function setup(speech: FakeSpeechApi | undefined, extra: Record<string, unknown> = {}) {
  const db = new SqliteHarness();
  const overrides: Record<string, unknown> = {
    storage: { openDatabase: async () => db },
    bible: {
      listModules: async () => [MODULE_KJV],
      getRange: async () => [{ verseId: JOHN_3_16, text: TEXT, textPlain: TEXT }],
    },
    ...extra,
  };
  const api = createMockApi(overrides);
  (api as unknown as { speech: unknown }).speech = speech;
  await activate(api);

  const collection = await db.queryOne<{ id: number }>('SELECT id FROM collection LIMIT 1');
  const res = await db.run(
    `INSERT INTO passage (collection_id, module_id, start_verse_id, end_verse_id, reference, verse_count, added_at)
     VALUES (?, 'KJV', ?, ?, 'John 3:16', 1, 0)`,
    [collection?.id, JOHN_3_16, JOHN_3_16],
  );
  const passageId = Number(res.lastInsertRowid);
  for (const rung of ['blanks', 'firstletters', 'recite']) {
    await db.run(
      `INSERT INTO card (passage_id, rung, state, interval_step, due_at, streak, last_score)
       VALUES (?, ?, 'new', -1, NULL, 0, NULL)`,
      [passageId, rung],
    );
  }
  return { db, api, passageId, channel: getMockPanelChannel(api) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function untilPhase(channel: Channel, phase: string): Promise<ReciteStateView> {
  for (let i = 0; i < 500; i++) {
    const s = await call<ReciteStateView | null>(channel, { type: 'getReciteState' });
    if (s && s.phase === phase) return s;
    await tick();
  }
  throw new Error(`timed out waiting for phase ${phase}`);
}

const fakeSpeech = (script: ScriptItem[] = [], status: Record<string, unknown> = {}) =>
  new FakeSpeechApi({ script, granted: { listen: true, speak: true }, status });

async function reciteOnce(channel: Channel, passageId: number): Promise<ReciteStateView> {
  const started = await call<ReciteStateView>(channel, {
    type: 'startRecite',
    source: { kind: 'passage', passageId },
    mode: 'tap',
  });
  await untilPhase(channel, 'ready');
  await call(channel, { type: 'reciteControl', reciteId: started.reciteId, action: 'listen' });
  return untilPhase(channel, 'feedback');
}

describe('recite through the worker', () => {
  it('does a tap-mode recitation: attempt, detail, schedule, and keeps it out of dueCount', async () => {
    const { db, channel, passageId } = await setup(fakeSpeech([{ say: TEXT }]));

    const fb = await reciteOnce(channel, passageId);
    expect(fb.result?.score).toBe(1);
    expect(fb.result?.nextDueAt).toBeGreaterThan(0);

    const card = await db.queryOne<{ id: number; due_at: number | null; streak: number; last_score: number }>(
      `SELECT id, due_at, streak, last_score FROM card WHERE passage_id = ? AND rung = 'recite'`,
      [passageId],
    );
    expect(card?.due_at).toBe(fb.result?.nextDueAt);
    expect(card?.last_score).toBe(1);

    const attempts = await db.query<{ id: number; card_id: number; score: number; tier: number }>(
      `SELECT id, card_id, score, tier FROM attempt`,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ card_id: card?.id, score: 1, tier: 0 });

    const detail = await db.query<{ attempt_id: number; verdicts: string; extras: number }>(
      `SELECT attempt_id, verdicts, extras FROM recite_detail`,
    );
    expect(detail).toHaveLength(1);
    expect(detail[0]!.attempt_id).toBe(attempts[0]!.id);
    expect(detail[0]!.verdicts).toMatch(/^c+$/);
    expect(detail[0]!.verdicts.length).toBe(TEXT.split(/\s+/).length);
    expect(detail[0]!.extras).toBe(0);

    // Make it due: the plan's dueCount/totalDue never include recite.
    await db.run(`UPDATE card SET due_at = 1 WHERE id = ?`, [card?.id]);
    const plan = await call<PlanView>(channel, { type: 'getPlan' });
    expect(plan.totalDue).toBe(0);
    expect(plan.passages[0]!.dueCount).toBe(0);
    expect(plan.reciteDueCount).toBe(1);
    expect(plan.speech.state).toBe('ready');
    const rv = plan.passages[0]!.rungs.find((r) => r.rung === 'recite')!;
    expect(rv.optional).toBe(true);
    expect(rv.applicable).toBe(true);
    expect(rv.attempts).toBe(1);
    expect(plan.passages[0]!.bestLevel).toBeGreaterThan(0);

    const view = await call<PassageView>(channel, { type: 'getPassageView', passageId });
    expect(view.rungs.find((r) => r.rung === 'recite')?.optional).toBe(true);
  });

  it('counts an untried recite card only when the passage is switched on, and Delete history keeps the schedule', async () => {
    const { db, channel, passageId } = await setup(fakeSpeech([{ say: TEXT }]));
    expect((await call<PlanView>(channel, { type: 'getPlan' })).reciteDueCount).toBe(0);

    const view = await call<PassageView>(channel, { type: 'setPassageRecite', passageId, on: true });
    expect(view.passage.reciteOn).toBe(true);
    expect((await call<PlanView>(channel, { type: 'getPlan' })).reciteDueCount).toBe(1);

    await reciteOnce(channel, passageId);
    await call(channel, { type: 'deleteReciteHistory' });
    expect(await db.query(`SELECT 1 FROM recite_detail`)).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM attempt`)).toHaveLength(1);
    const card = await db.queryOne<{ due_at: number | null }>(
      `SELECT due_at FROM card WHERE passage_id = ? AND rung = 'recite'`,
      [passageId],
    );
    expect(card?.due_at).not.toBeNull();
  });

  it('reports permission-missing, and refuses to start', async () => {
    const speech = new FakeSpeechApi({ granted: { listen: false, speak: false } });
    const { channel, passageId } = await setup(speech);

    const plan = await call<PlanView>(channel, { type: 'getPlan' });
    expect(plan.speech.state).toBe('permission-missing');
    expect(plan.speech.missingPermissions).toContain('speech:listen');
    expect(plan.passages[0]!.rungs.find((r) => r.rung === 'recite')?.applicable).toBe(false);

    const settings = await call<SettingsView>(channel, { type: 'getSettings' });
    expect(settings.speech.state).toBe('permission-missing');
    expect(settings.recite.strictness).toBe('normal');

    await expect(
      call(channel, { type: 'startRecite', source: { kind: 'passage', passageId }, mode: 'tap' }),
    ).rejects.toThrow(/speech:listen/);
  });

  it('persists recite settings', async () => {
    const { channel } = await setup(fakeSpeech());
    await call(channel, { type: 'setReciteSettings', patch: { strictness: 'strict', hintDelayMs: 99999 } });
    const s = await call<SettingsView>(channel, { type: 'getSettings' });
    expect(s.recite.strictness).toBe('strict');
    expect(s.recite.hintDelayMs).toBe(30000);
  });

  it('still activates when the host has no api.speech (host-too-old)', async () => {
    const { channel } = await setup(undefined);
    const plan = await call<PlanView>(channel, { type: 'getPlan' });
    expect(plan.speech.state).toBe('host-too-old');
    expect(plan.reciteDueCount).toBe(0);
  });

  it('practiceDueAloud names the reason when speech is unavailable', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const { api } = await setup(fakeSpeech([], { listen: 'unavailable' }), { ui: { showNotification } });
    expect(getMockRuntimeEndpoints(api).list()).toContain('practiceDueAloud');
    await getMockRuntimeEndpoints(api).invoke('practiceDueAloud');
    expect(showNotification).toHaveBeenCalledWith(expect.stringMatching(/not available/));
  });

  it('practiceDueAloud starts a due loop and opens the panel when ready', async () => {
    const openPanel = vi.fn().mockResolvedValue(undefined);
    const { api, db, passageId, channel } = await setup(fakeSpeech([{ say: TEXT }]), {
      workspace: { openPanel },
    });
    await call(channel, { type: 'setPassageRecite', passageId, on: true });
    await getMockRuntimeEndpoints(api).invoke('practiceDueAloud');
    expect(openPanel).toHaveBeenCalledWith('panel');
    const state = await call<ReciteStateView | null>(channel, { type: 'getReciteState' });
    expect(state?.source).toBe('due');
    await call(channel, { type: 'reciteControl', reciteId: state!.reciteId, action: 'stop' });
    expect(await db.query(`SELECT 1 FROM attempt`)).toHaveLength(0);
  });

  it('stores no heard text or audio anywhere', async () => {
    const { db, channel, passageId } = await setup(fakeSpeech([{ say: `${TEXT} ${SENTINEL}` }]));
    const fb = await reciteOnce(channel, passageId);
    expect(fb.result?.extras.length).toBeGreaterThan(0);

    const tables = await db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    for (const { name } of tables) {
      const rows = await db.query<Record<string, unknown>>(`SELECT * FROM "${name}"`);
      expect(JSON.stringify(rows).toLowerCase(), name).not.toContain(SENTINEL);
    }
    const detail = await db.queryOne<{ extras: number }>(`SELECT extras FROM recite_detail`);
    expect(detail?.extras).toBeGreaterThan(0);
  });

  it('deactivate stops a listening loop', async () => {
    const speech = fakeSpeech([]);
    const stops: string[] = [];
    const orig = speech.stopListening.bind(speech);
    speech.stopListening = async (id: string) => {
      stops.push(id);
      return orig(id);
    };
    const { channel, passageId } = await setup(speech);
    const started = await call<ReciteStateView>(channel, {
      type: 'startRecite',
      source: { kind: 'passage', passageId },
      mode: 'tap',
    });
    await untilPhase(channel, 'ready');
    await call(channel, { type: 'reciteControl', reciteId: started.reciteId, action: 'listen' });
    for (let i = 0; i < 50 && speech.starts.length === 0; i++) await tick();
    deactivate();
    for (let i = 0; i < 50 && stops.length === 0; i++) await tick();
    expect(stops.length).toBeGreaterThan(0);
  });
});
