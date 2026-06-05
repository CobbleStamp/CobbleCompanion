/**
 * Reinforcement — the will's half of the affect loop. A mood change is attributed
 * to the pending drive-serving act and nudges that drive's weight; ordinary chat
 * (no pending act) is a no-op; a zero change resolves the outcome without moving
 * personality. Backed by the real store + identity over an in-memory database.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';
import { reinforceFromDelta } from './reinforce.js';
import { DEFAULT_DRIVE_WEIGHTS, resolveWeights } from './drives.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('reinforceFromDelta', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let identity: DrizzleIdentityStore;
  let rewards: DrizzleProactiveOutcomeStore;

  function deps() {
    return { rewards, identity, logger: silent };
  }

  async function pendingCuriosityOutcome(): Promise<string> {
    const outcome = await rewards.record(companionId, { drive: 'curiosity' });
    return outcome.id;
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    rewards = new DrizzleProactiveOutcomeStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('a positive change resolves the pending outcome and raises the served weight', async () => {
    await pendingCuriosityOutcome();
    await reinforceFromDelta(deps(), companionId, 0.8);

    const [outcome] = await rewards.list(companionId, 1);
    expect(outcome!.reward).toBeCloseTo(0.8);
    const companion = await identity.getCompanionById(companionId);
    expect(resolveWeights(companion!.driveWeights).curiosity).toBeGreaterThan(
      DEFAULT_DRIVE_WEIGHTS.curiosity,
    );
  });

  it('a negative change lowers the served weight', async () => {
    await pendingCuriosityOutcome();
    await reinforceFromDelta(deps(), companionId, -0.8);

    const companion = await identity.getCompanionById(companionId);
    expect(resolveWeights(companion!.driveWeights).curiosity).toBeLessThan(
      DEFAULT_DRIVE_WEIGHTS.curiosity,
    );
  });

  it('a zero change resolves the outcome but leaves personality untouched', async () => {
    await pendingCuriosityOutcome();
    await reinforceFromDelta(deps(), companionId, 0);

    const [outcome] = await rewards.list(companionId, 1);
    expect(outcome!.reward).toBe(0);
    expect(outcome!.resolvedAt).not.toBeNull(); // resolved — won't be re-scored
    const companion = await identity.getCompanionById(companionId);
    expect(companion!.driveWeights).toBeNull(); // never written
  });

  it('is a no-op when nothing is awaiting a reaction (ordinary chat)', async () => {
    await reinforceFromDelta(deps(), companionId, 0.9);
    expect(await rewards.list(companionId, 10)).toHaveLength(0);
    const companion = await identity.getCompanionById(companionId);
    expect(companion!.driveWeights).toBeNull();
  });

  it('attributes the change to the drive the pending act served', async () => {
    await rewards.record(companionId, { drive: 'bond' });
    await reinforceFromDelta(deps(), companionId, 0.5);

    const companion = await identity.getCompanionById(companionId);
    const weights = resolveWeights(companion!.driveWeights);
    expect(weights.bond).toBeGreaterThan(DEFAULT_DRIVE_WEIGHTS.bond);
    expect(weights.curiosity).toBe(DEFAULT_DRIVE_WEIGHTS.curiosity); // untouched
  });
});
