/** Reward attribution — sets the outcome reward and nudges the served drive weight. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleProposalStore } from '../tools/proposal-store.js';
import { DEFAULT_DRIVE_WEIGHTS, resolveWeights } from './drives.js';
import { applyProposalReward } from './reward.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('applyProposalReward', () => {
  let db: Database;
  let close: () => Promise<void>;
  let identity: DrizzleIdentityStore;
  let rewards: DrizzleProactiveOutcomeStore;
  let companionId: string;
  let proposalId: string;

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
    const proposal = await new DrizzleProposalStore(db).create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://x.dev' },
      summary: 'Remember https://x.dev',
      origin: 'autonomous',
    });
    proposalId = proposal.id;
    await rewards.record(companionId, {
      proposalId,
      drive: 'curiosity',
      driveSnapshot: DEFAULT_DRIVE_WEIGHTS,
    });
  });
  afterEach(async () => {
    await close();
  });

  it('approval sets a positive reward and raises the served drive weight', async () => {
    await applyProposalReward(
      { rewards, identity, logger: silent },
      companionId,
      proposalId,
      'approved',
    );

    const outcome = await rewards.findByProposal(companionId, proposalId);
    expect(outcome?.reward).toBe(1);
    const companion = await identity.getCompanionById(companionId);
    expect(resolveWeights(companion!.driveWeights).curiosity).toBeGreaterThan(
      DEFAULT_DRIVE_WEIGHTS.curiosity,
    );
  });

  it('rejection sets a negative reward and lowers the served drive weight', async () => {
    await applyProposalReward(
      { rewards, identity, logger: silent },
      companionId,
      proposalId,
      'rejected',
    );

    expect((await rewards.findByProposal(companionId, proposalId))?.reward).toBe(-1);
    const companion = await identity.getCompanionById(companionId);
    expect(resolveWeights(companion!.driveWeights).curiosity).toBeLessThan(
      DEFAULT_DRIVE_WEIGHTS.curiosity,
    );
  });

  it('is a no-op for a proposal with no recorded outcome (e.g. chat-origin)', async () => {
    const chat = await new DrizzleProposalStore(db).create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://y.dev' },
      summary: 'Remember https://y.dev',
    });
    await applyProposalReward(
      { rewards, identity, logger: silent },
      companionId,
      chat.id,
      'approved',
    );
    // No weights were learned (still null → neutral).
    const companion = await identity.getCompanionById(companionId);
    expect(companion?.driveWeights).toBeNull();
  });
});
