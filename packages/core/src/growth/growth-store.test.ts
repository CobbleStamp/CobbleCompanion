/** Growth store — lazy seed, idempotent compare-and-set advance, guarded treat spend. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleGrowthStore, type GrowthSnapshot } from './growth-store.js';

const INITIAL_TREATS = 5;

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
    growth = new DrizzleGrowthStore(db, { initialTreats: INITIAL_TREATS });
  });
  afterEach(async () => {
    await close();
  });

  it('lazily creates the row seeded with the initial treats', async () => {
    const snapshot = await growth.getSnapshot(companionId);
    expect(snapshot).toEqual<GrowthSnapshot>({
      knowledgeBand: 0,
      bondBand: 0,
      initiativeBand: 0,
      observedCapabilities: [],
      treats: INITIAL_TREATS,
    });
  });

  it('advances the mark and awards treats when the guard matches', async () => {
    const from = await growth.getSnapshot(companionId);
    const won = await growth.advance(
      companionId,
      from,
      {
        knowledgeBand: 2,
        bondBand: 1,
        initiativeBand: 0,
        observedCapabilities: ['web_research'],
      },
      4,
    );
    expect(won).toBe(true);
    const after = await growth.getSnapshot(companionId);
    expect(after.knowledgeBand).toBe(2);
    expect(after.observedCapabilities).toEqual(['web_research']);
    expect(after.treats).toBe(INITIAL_TREATS + 4);
  });

  it('refuses a stale advance (idempotent — no double award)', async () => {
    const from = await growth.getSnapshot(companionId);
    await growth.advance(
      companionId,
      from,
      { knowledgeBand: 1, bondBand: 0, initiativeBand: 0, observedCapabilities: [] },
      2,
    );
    // A second caller still holding the OLD snapshot loses the compare-and-set.
    const wonAgain = await growth.advance(
      companionId,
      from,
      { knowledgeBand: 1, bondBand: 0, initiativeBand: 0, observedCapabilities: [] },
      2,
    );
    expect(wonAgain).toBe(false);
    expect((await growth.getSnapshot(companionId)).treats).toBe(INITIAL_TREATS + 2);
  });

  it('spends treats only when affordable and never goes negative', async () => {
    expect(await growth.spendTreats(companionId, 3)).toBe(true);
    expect((await growth.getSnapshot(companionId)).treats).toBe(INITIAL_TREATS - 3);
    // Balance is 2; a 5-treat food is unaffordable and leaves the balance intact.
    expect(await growth.spendTreats(companionId, 5)).toBe(false);
    expect((await growth.getSnapshot(companionId)).treats).toBe(INITIAL_TREATS - 3);
  });

  it('treats a non-positive spend as a no-op success', async () => {
    expect(await growth.spendTreats(companionId, 0)).toBe(true);
    expect((await growth.getSnapshot(companionId)).treats).toBe(INITIAL_TREATS);
  });
});
