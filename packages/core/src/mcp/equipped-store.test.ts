/**
 * Equipped-set store tests against the real PGlite database: equip inserts and
 * (on re-load) refreshes the schema + recency; touch bumps recency;
 * evictToMaxEquipped removes the least-recently-used beyond the cap.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { McpToolSnapshot } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEquippedToolStore, type EquipInput } from './equipped-store.js';

const snapshot = (name: string): McpToolSnapshot => ({
  name,
  description: `the ${name} tool`,
  inputSchema: { type: 'object', properties: {} },
});

const input = (toolId: string, name = toolId): EquipInput => ({
  toolId,
  source: 'mcp',
  serverRef: 'stocks',
  snapshot: snapshot(name),
});

describe('DrizzleEquippedToolStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let clock: Date;

  function store(): DrizzleEquippedToolStore {
    return new DrizzleEquippedToolStore(db, { now: () => clock });
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    clock = new Date('2026-06-06T00:00:00Z');
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });
  afterEach(async () => {
    await close();
  });

  it('equips a tool and lists it', async () => {
    await store().equip(companionId, input('a'));
    const all = await store().list(companionId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ toolId: 'a', serverRef: 'stocks' });
  });

  it('re-loading refreshes the snapshot and bumps recency', async () => {
    const s = store();
    await s.equip(companionId, input('a'));
    clock = new Date('2026-06-06T02:00:00Z');
    await s.equip(companionId, { ...input('a'), snapshot: snapshot('a-v2') });
    const record = await s.get(companionId, 'a');
    expect(record?.snapshot.name).toBe('a-v2');
    expect(record?.lastUsedAt.toISOString()).toBe('2026-06-06T02:00:00.000Z');
    expect(await s.list(companionId)).toHaveLength(1); // upsert, not a duplicate
  });

  it('touch bumps recency', async () => {
    const s = store();
    await s.equip(companionId, input('a'));
    clock = new Date('2026-06-06T01:00:00Z');
    await s.touch(companionId, 'a');
    const record = await s.get(companionId, 'a');
    expect(record?.lastUsedAt.toISOString()).toBe('2026-06-06T01:00:00.000Z');
  });

  it('evicts the least-recently-used beyond the cap', async () => {
    const s = store();
    for (const id of ['a', 'b', 'c']) {
      await s.equip(companionId, input(id));
      clock = new Date(clock.getTime() + 60_000); // each newer than the last
    }
    // a is oldest. Cap 2 → a is evicted.
    const evicted = await s.evictToMaxEquipped(companionId, 2);
    expect(evicted).toBe(1);
    const ids = (await s.list(companionId)).map((r) => r.toolId).sort();
    expect(ids).toEqual(['b', 'c']);
  });

  it('a touched tool survives eviction over an idle one', async () => {
    const s = store();
    await s.equip(companionId, input('old'));
    clock = new Date(clock.getTime() + 60_000);
    await s.equip(companionId, input('fresh'));
    // Re-touch 'old' so it becomes the most-recently-used.
    clock = new Date(clock.getTime() + 60_000);
    await s.touch(companionId, 'old');
    // Cap 1 → the now-idle 'fresh' is evicted, 'old' survives.
    expect(await s.evictToMaxEquipped(companionId, 1)).toBe(1);
    const ids = (await s.list(companionId)).map((r) => r.toolId);
    expect(ids).toEqual(['old']);
  });

  it('evictToMaxEquipped is a no-op under the cap', async () => {
    const s = store();
    await s.equip(companionId, input('a'));
    expect(await s.evictToMaxEquipped(companionId, 8)).toBe(0);
  });
});
