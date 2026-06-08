/** Growth store — lazy seed at the empty mark, idempotent compare-and-set advance. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleGrowthStore, type GrowthSnapshot } from './growth-store.js';

describe('DrizzleGrowthStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let growth: DrizzleGrowthStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    growth = new DrizzleGrowthStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('lazily creates the row at the empty mark (no spendable currency)', async () => {
    const snapshot = await growth.getSnapshot(companionId);
    expect(snapshot).toEqual<GrowthSnapshot>({
      knowledgeBand: 0,
      bondBand: 0,
      initiativeBand: 0,
      observedCapabilities: [],
    });
  });

  it('advances the mark when the guard matches', async () => {
    const from = await growth.getSnapshot(companionId);
    const won = await growth.advance(companionId, from, {
      knowledgeBand: 2,
      bondBand: 1,
      initiativeBand: 0,
      observedCapabilities: ['web_research'],
    });
    expect(won).toBe(true);
    const after = await growth.getSnapshot(companionId);
    expect(after.knowledgeBand).toBe(2);
    expect(after.bondBand).toBe(1);
    expect(after.observedCapabilities).toEqual(['web_research']);
  });

  it('refuses a stale advance (idempotent — no double-fire)', async () => {
    const from = await growth.getSnapshot(companionId);
    await growth.advance(companionId, from, {
      knowledgeBand: 1,
      bondBand: 0,
      initiativeBand: 0,
      observedCapabilities: [],
    });
    // A second caller still holding the OLD snapshot loses the compare-and-set.
    const wonAgain = await growth.advance(companionId, from, {
      knowledgeBand: 1,
      bondBand: 0,
      initiativeBand: 0,
      observedCapabilities: [],
    });
    expect(wonAgain).toBe(false);
    expect((await growth.getSnapshot(companionId)).knowledgeBand).toBe(1);
  });
});
