/**
 * Reinforcement — the will's half of the affect loop. A mood change is attributed
 * to the pending drive-serving act and nudges that drive's weight; ordinary chat
 * (no pending act) is a no-op; a zero change resolves the outcome without moving
 * personality. Backed by the real store + identity over an in-memory database.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DriveWeights } from '@cobble/shared';
import { DrizzleIdentityStore, type IdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import {
  DrizzleProactiveOutcomeStore,
  type ProactiveOutcomeRecord,
  type ProactiveOutcomeStore,
} from './reward-store.js';
import { reinforceFromDelta } from './reinforce.js';
import { DEFAULT_DRIVE_WEIGHTS, resolveWeights } from './drives.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Logger that captures `error` calls so a swallowed failure can be asserted. */
interface CapturingLogger extends Logger {
  readonly errors: string[];
}
function capturingLogger(): CapturingLogger {
  const errors: string[] = [];
  return {
    errors,
    error: (message: string): void => {
      errors.push(message);
    },
    warn: () => {},
    info: () => {},
  };
}

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

/**
 * Concurrency / failure branches driven with fakes (the real Drizzle store can't
 * be made to lose a claim or vanish a companion deterministically in-process).
 */
describe('reinforceFromDelta — claim-loss, vanished companion, and swallowed errors', () => {
  const PENDING: ProactiveOutcomeRecord = {
    id: 'outcome-1',
    companionId: 'pip',
    noteMessageId: 'note-1',
    proposalId: null,
    drive: 'curiosity',
    reward: null,
    createdAt: new Date(),
    resolvedAt: null,
  };

  /** Fake reward store with overridable behaviour for the two race outcomes. */
  class FakeRewardStore implements ProactiveOutcomeStore {
    constructor(
      private readonly outcome: ProactiveOutcomeRecord | null,
      private readonly claims: boolean,
    ) {}
    async record(): Promise<ProactiveOutcomeRecord> {
      throw new Error('not used');
    }
    async findLatestUnresolved(): Promise<ProactiveOutcomeRecord | null> {
      return this.outcome;
    }
    async setReward(): Promise<boolean> {
      return this.claims;
    }
    async list(): Promise<readonly ProactiveOutcomeRecord[]> {
      return [];
    }
  }

  /** Fake identity that records updateDriveWeights calls and an optional companion. */
  class FakeIdentity {
    readonly updated: DriveWeights[] = [];
    constructor(private readonly companion: { driveWeights: DriveWeights | null } | null) {}
    async getCompanionById(): Promise<{ driveWeights: DriveWeights | null } | null> {
      return this.companion;
    }
    async updateDriveWeights(_id: string, weights: DriveWeights): Promise<void> {
      this.updated.push(weights);
    }
  }

  it('does NOT nudge weights when the claim is lost to a concurrent reaction', async () => {
    const fakeIdentity = new FakeIdentity({ driveWeights: null });
    // setReward returns false → another racer already scored this outcome.
    const rewards = new FakeRewardStore(PENDING, false);

    await reinforceFromDelta(
      { rewards, identity: fakeIdentity as unknown as IdentityStore, logger: silent },
      'pip',
      0.8,
    );

    expect(fakeIdentity.updated).toHaveLength(0);
  });

  it('does NOT nudge weights when the companion has vanished after a claimed delta', async () => {
    // Claim succeeds (true) with a non-zero delta, but the companion is gone.
    const fakeIdentity = new FakeIdentity(null);
    const rewards = new FakeRewardStore(PENDING, true);

    await reinforceFromDelta(
      { rewards, identity: fakeIdentity as unknown as IdentityStore, logger: silent },
      'pip',
      0.8,
    );

    expect(fakeIdentity.updated).toHaveLength(0);
  });

  it('logs and swallows a thrown error from the store, never throwing', async () => {
    const logger = capturingLogger();
    const throwingRewards: ProactiveOutcomeStore = {
      async record(): Promise<ProactiveOutcomeRecord> {
        throw new Error('not used');
      },
      async findLatestUnresolved(): Promise<ProactiveOutcomeRecord | null> {
        throw new Error('store down');
      },
      async setReward(): Promise<boolean> {
        return false;
      },
      async list(): Promise<readonly ProactiveOutcomeRecord[]> {
        return [];
      },
    };
    const fakeIdentity = new FakeIdentity({ driveWeights: null });

    await expect(
      reinforceFromDelta(
        { rewards: throwingRewards, identity: fakeIdentity as unknown as IdentityStore, logger },
        'pip',
        0.8,
      ),
    ).resolves.toBeUndefined();

    expect(logger.errors).toContain('failed to reinforce from affect delta');
    expect(fakeIdentity.updated).toHaveLength(0);
  });
});
