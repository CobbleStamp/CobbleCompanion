/** Feeding economy — food spends treats and tops up the favoured pool; broke = no-op. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { foodDef, type FoodType } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEnergyStore } from '../quota/energy-store.js';
import { DrizzleTokenQuotaStore } from '../quota/stamina-store.js';
import { DEFAULT_GROWTH_CONFIG } from './config.js';
import { feed, type FeedDeps } from './economy.js';
import { DrizzleGrowthStore } from './growth-store.js';

const CAP = 1_000_000;

describe('feed', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let ownerId: string;
  let deps: FeedDeps;
  let energy: DrizzleCompanionEnergyStore;
  let quota: DrizzleTokenQuotaStore;
  let growth: DrizzleGrowthStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    ownerId = user.id;
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: CAP });
    quota = new DrizzleTokenQuotaStore(db, { defaultCapTokens: CAP });
    growth = new DrizzleGrowthStore(db, { initialTreats: DEFAULT_GROWTH_CONFIG.initialTreats });
    deps = { growth, quota, energy };
  });
  afterEach(async () => {
    await close();
  });

  it('a spark spends a treat and tops up the energy pool', async () => {
    const result = await feed(deps, { companionId, ownerId, food: 'spark' });
    expect(result.ok).toBe(true);
    const spark = foodDef('spark')!;
    expect((await energy.getEnergy(companionId)).capTokens).toBe(CAP + spark.energyTokens);
    expect((await growth.getSnapshot(companionId)).treats).toBe(
      DEFAULT_GROWTH_CONFIG.initialTreats - spark.treatCost,
    );
  });

  it('a ration tops up the stamina pool', async () => {
    await feed(deps, { companionId, ownerId, food: 'ration' });
    const ration = foodDef('ration')!;
    expect((await quota.getUsage(ownerId)).capTokens).toBe(CAP + ration.staminaTokens);
  });

  it('fails without spending or topping up when treats run out', async () => {
    // Exhaust the starting balance (each food costs 1 treat).
    for (let i = 0; i < DEFAULT_GROWTH_CONFIG.initialTreats; i += 1) {
      expect((await feed(deps, { companionId, ownerId, food: 'spark' })).ok).toBe(true);
    }
    const capBefore = (await energy.getEnergy(companionId)).capTokens;
    const broke = await feed(deps, { companionId, ownerId, food: 'spark' });
    expect(broke.ok).toBe(false);
    expect(broke.reason).toBe('not enough treats');
    expect((await energy.getEnergy(companionId)).capTokens).toBe(capBefore);
  });

  it('rejects an unknown food', async () => {
    const result = await feed(deps, { companionId, ownerId, food: 'bogus' as FoodType });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown food');
  });
});
