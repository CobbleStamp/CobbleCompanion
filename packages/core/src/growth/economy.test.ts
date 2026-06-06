/** Feeding economy — food spends treats and tops up the favoured pool; broke = no-op. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { foodDef, type FoodType } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleCompanionEnergyStore } from '../quota/energy-store.js';
import { DrizzleTokenQuotaStore } from '../quota/stamina-store.js';
import { DEFAULT_GROWTH_CONFIG } from './config.js';
import { feed, type FeedDeps } from './economy.js';
import { DrizzleGrowthStore } from './growth-store.js';

const CAP = 1_000_000;

/** A logger that records its `error` calls, so we can assert a lost treat is audited. */
function recordingLogger(): Logger & {
  errors: { message: string; context: Record<string, unknown> }[];
} {
  const errors: { message: string; context: Record<string, unknown> }[] = [];
  return {
    errors,
    error: (message, context) => errors.push({ message, context }),
    warn: () => {},
    info: () => {},
  };
}

describe('feed', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let ownerId: string;
  let deps: FeedDeps;
  let energy: DrizzleCompanionEnergyStore;
  let quota: DrizzleTokenQuotaStore;
  let growth: DrizzleGrowthStore;
  let logger: ReturnType<typeof recordingLogger>;

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
    logger = recordingLogger();
    deps = { growth, quota, energy, logger };
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

  it('a treat spends one treat and tops up BOTH pools', async () => {
    const treat = foodDef('treat')!;
    // The treat is the only food that feeds stamina AND energy in one call — it also
    // exercises the partial-grant accounting (`staminaToppedUp`) on the happy path.
    expect(treat.staminaTokens).toBeGreaterThan(0);
    expect(treat.energyTokens).toBeGreaterThan(0);

    const result = await feed(deps, { companionId, ownerId, food: 'treat' });
    expect(result.ok).toBe(true);
    expect((await quota.getUsage(ownerId)).capTokens).toBe(CAP + treat.staminaTokens);
    expect((await energy.getEnergy(companionId)).capTokens).toBe(CAP + treat.energyTokens);
    expect((await growth.getSnapshot(companionId)).treats).toBe(
      DEFAULT_GROWTH_CONFIG.initialTreats - treat.treatCost,
    );
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

  it('audits the lost treat (and rethrows) when a top-up fails after the debit', async () => {
    const boom = new Error('energy store unavailable');
    // Force the top-up to throw *after* the treat has already been debited.
    energy.topUp = async () => {
      throw boom;
    };
    const treatsBefore = (await growth.getSnapshot(companionId)).treats;

    await expect(feed(deps, { companionId, ownerId, food: 'spark' })).rejects.toThrow(boom);

    // The treat is gone (no refund) — that's exactly why it must be auditable.
    expect((await growth.getSnapshot(companionId)).treats).toBe(
      treatsBefore - foodDef('spark')!.treatCost,
    );
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.context).toMatchObject({
      companionId,
      ownerId,
      food: 'spark',
      error: boom,
    });
  });

  it('rejects an unknown food', async () => {
    const result = await feed(deps, { companionId, ownerId, food: 'bogus' as FoodType });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown food');
  });
});
