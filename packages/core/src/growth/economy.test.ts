/**
 * Feeding economy — feeding consumes one food from the USER's pantry and adds its
 * grants to the fed COMPANION's vitality wallet(s). One pantry feeds any of the
 * user's companions; an empty pantry is a no-op with a reason; a wallet-add that
 * fails after the food is consumed is audited and rethrown (no phantom success).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { foodDef, type FoodType } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { CompanionNotFoundError, DrizzleVitalityStore } from '../quota/vitality-store.js';
import { DEFAULT_GROWTH_CONFIG } from './config.js';
import { feed, type FeedDeps } from './economy.js';
import { DrizzleFoodStore } from './food-store.js';

/** Companions are created with empty wallets here, so a feed's grant is exactly the
 * wallet's new balance. */
const START = 0;
const INITIAL_FOOD = DEFAULT_GROWTH_CONFIG.initialFood;

/** A logger that records its `error` calls, so we can assert a lost food is audited. */
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
  let userId: string;
  let deps: FeedDeps;
  let energy: DrizzleVitalityStore;
  let stamina: DrizzleVitalityStore;
  let food: DrizzleFoodStore;
  let logger: ReturnType<typeof recordingLogger>;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db, { startingVitalityTokens: START });
    const user = await identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    stamina = new DrizzleVitalityStore(db, 'stamina');
    energy = new DrizzleVitalityStore(db, 'energy');
    food = new DrizzleFoodStore(db, { initialFood: INITIAL_FOOD });
    logger = recordingLogger();
    deps = { food, stamina, energy, logger };
  });
  afterEach(async () => {
    await close();
  });

  it('a spark consumes a spark from the pantry and feeds the energy wallet', async () => {
    const result = await feed(deps, { companionId, userId, food: 'spark' });
    expect(result.ok).toBe(true);
    const spark = foodDef('spark')!;
    expect(await energy.getBalance(companionId)).toBe(START + spark.energyTokens);
    expect((await food.getPantry(userId)).spark).toBe(INITIAL_FOOD - 1);
  });

  it('a ration feeds the stamina wallet', async () => {
    await feed(deps, { companionId, userId, food: 'ration' });
    const ration = foodDef('ration')!;
    expect(await stamina.getBalance(companionId)).toBe(START + ration.staminaTokens);
    expect((await food.getPantry(userId)).ration).toBe(INITIAL_FOOD - 1);
  });

  it('a treat consumes one treat and feeds BOTH wallets', async () => {
    const treat = foodDef('treat')!;
    expect(treat.staminaTokens).toBeGreaterThan(0);
    expect(treat.energyTokens).toBeGreaterThan(0);

    const result = await feed(deps, { companionId, userId, food: 'treat' });
    expect(result.ok).toBe(true);
    expect(await stamina.getBalance(companionId)).toBe(START + treat.staminaTokens);
    expect(await energy.getBalance(companionId)).toBe(START + treat.energyTokens);
    expect((await food.getPantry(userId)).treat).toBe(INITIAL_FOOD - 1);
  });

  it("one user's pantry feeds two of their companions independently", async () => {
    // The whole point of the per-USER pantry + per-COMPANION wallets: a user spends
    // the same pantry to feed any of their companions, and each companion's wallet
    // rises on its own — feeding A never touches B's wallet.
    const sibling = await new DrizzleIdentityStore(db, {
      startingVitalityTokens: START,
    }).createCompanion(userId, {
      name: 'Quill',
      form: 'owl',
      temperament: 'watchful',
    });
    const ration = foodDef('ration')!;

    // Feed companion A a ration → A's stamina rises, pantry down by one.
    expect((await feed(deps, { companionId, userId, food: 'ration' })).ok).toBe(true);
    expect(await stamina.getBalance(companionId)).toBe(START + ration.staminaTokens);
    expect(await stamina.getBalance(sibling.id)).toBe(START); // sibling untouched
    expect((await food.getPantry(userId)).ration).toBe(INITIAL_FOOD - 1);

    // Feed companion B a ration → B's stamina rises, A unchanged, pantry down again.
    expect((await feed(deps, { companionId: sibling.id, userId, food: 'ration' })).ok).toBe(true);
    expect(await stamina.getBalance(sibling.id)).toBe(START + ration.staminaTokens);
    expect(await stamina.getBalance(companionId)).toBe(START + ration.staminaTokens); // A unchanged
    expect((await food.getPantry(userId)).ration).toBe(INITIAL_FOOD - 2); // down by two total
  });

  it('fails without touching the wallets when the pantry is empty', async () => {
    // Drain every ration the user holds.
    for (let i = 0; i < INITIAL_FOOD; i += 1) {
      expect((await feed(deps, { companionId, userId, food: 'ration' })).ok).toBe(true);
    }
    const staminaBefore = await stamina.getBalance(companionId);

    const broke = await feed(deps, { companionId, userId, food: 'ration' });
    expect(broke.ok).toBe(false);
    expect(broke.reason).toBe('out of ration');
    // Wallets untouched; pantry stays at zero (no negative drift).
    expect(await stamina.getBalance(companionId)).toBe(staminaBefore);
    expect((await food.getPantry(userId)).ration).toBe(0);
  });

  it('audits the lost food (and rethrows) when a wallet add fails after the consume', async () => {
    const boom = new Error('energy store unavailable');
    // Force the wallet add to throw *after* the food has already been consumed.
    energy.add = async () => {
      throw boom;
    };
    const pantryBefore = (await food.getPantry(userId)).spark;

    await expect(feed(deps, { companionId, userId, food: 'spark' })).rejects.toThrow(boom);

    // The food is gone (no refund) — that's exactly why it must be auditable.
    expect((await food.getPantry(userId)).spark).toBe(pantryBefore - 1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.context).toMatchObject({
      companionId,
      userId,
      food: 'spark',
      error: boom,
    });
  });

  it('audits and rethrows when the fed companion does not exist (no phantom success)', async () => {
    // A spark grants energy; feeding a missing companion consumes the food, then the
    // wallet add throws CompanionNotFoundError rather than silently granting nothing.
    const missing = '00000000-0000-0000-0000-000000000000';
    const pantryBefore = (await food.getPantry(userId)).spark;

    await expect(feed(deps, { companionId: missing, userId, food: 'spark' })).rejects.toThrow(
      CompanionNotFoundError,
    );

    // The food is gone (no refund) and the loss is audited — same contract as any
    // post-consume add failure.
    expect((await food.getPantry(userId)).spark).toBe(pantryBefore - 1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.context).toMatchObject({
      companionId: missing,
      userId,
      food: 'spark',
    });
  });

  it('rejects an unknown food', async () => {
    const result = await feed(deps, { companionId, userId, food: 'bogus' as FoodType });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown food');
  });
});
