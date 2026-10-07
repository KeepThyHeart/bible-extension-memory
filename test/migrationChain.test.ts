/**
 * The combined schema chain after reconciling 0071 (v6 recite) with 0072
 * (v7 push cards): one linear chain, old databases upgrade to the newest.
 */

import { describe, it, expect } from 'vitest';
import { SqliteHarness } from './sqliteHarness';
import { migrate, ensureDefaultCollection, SCHEMA_VERSION } from '../src/db';
import { MemoryStore } from '../src/store';

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

async function version(h: SqliteHarness): Promise<string | undefined> {
  return (await h.queryOne<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`))?.value;
}

/** Undo v7, then v6, then (optionally) the v5 soft-delete column, as a pre-upgrade database would lack them. */
async function rewind(h: SqliteHarness, to: 4 | 5): Promise<void> {
  await h.exec(`DROP INDEX push_card_state_fire`);
  await h.exec(`DROP TABLE push_card`);
  await h.exec(`DROP INDEX recite_detail_card_at`);
  await h.exec(`DROP TABLE recite_detail`);
  await h.exec(`ALTER TABLE passage DROP COLUMN recite_on`);
  if (to === 4) {
    await h.exec(`DROP INDEX IF EXISTS passage_deleted_at`);
    await h.exec(`ALTER TABLE passage DROP COLUMN deleted_at`);
  }
  await h.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, [String(to)]);
}

describe('combined migration chain', () => {
  it('is linear: newest version is 7', () => {
    expect(SCHEMA_VERSION).toBe(7);
  });

  it('a fresh database has both the recite and push-card schema', async () => {
    const h = new SqliteHarness();
    expect(await migrate(h)).toBe(SCHEMA_VERSION);
    const tables = (await h.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['recite_detail', 'push_card']));
    const cols = (await h.query<{ name: string }>(`PRAGMA table_info(passage)`)).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['recite_on', 'deleted_at']));
  });

  for (const from of [4, 5] as const) {
    it(`upgrades a populated v${from} database to ${SCHEMA_VERSION}, keeping rows`, async () => {
      const h = new SqliteHarness();
      await migrate(h);
      const collectionId = await ensureDefaultCollection(h, 'My plan', NOW);
      const store = new MemoryStore(h);
      const { passage } = await store.addPassage({
        collectionId, moduleId: 'kjv', startVerseId: 43003016, endVerseId: 43003017,
        reference: 'John 3:16-17', verseCount: 2, addedAt: NOW,
      });
      await store.syncLadders(collectionId);
      await h.run(`DELETE FROM card WHERE rung IN ('recite', 'recall')`);
      await rewind(h, from);
      expect(await version(h)).toBe(String(from));

      expect(await migrate(h)).toBe(SCHEMA_VERSION);
      expect(await version(h)).toBe(String(SCHEMA_VERSION));
      expect(await h.query(`SELECT id FROM passage WHERE id = ?`, [passage.id])).toHaveLength(1);
      const cols = (await h.query<{ name: string }>(`PRAGMA table_info(passage)`)).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['recite_on', 'deleted_at']));
      const tables = (await h.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(['recite_detail', 'push_card']));
      // A second run is a no-op.
      expect(await migrate(h)).toBe(SCHEMA_VERSION);
    });
  }
});
