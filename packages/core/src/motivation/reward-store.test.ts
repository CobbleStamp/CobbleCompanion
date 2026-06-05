/** Proactive-outcome store — record, find-by-proposal, set-reward, list. */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleLeadStore } from '../tools/lead-store.js';
import { DrizzleProposalStore } from '../tools/proposal-store.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';
import { DEFAULT_DRIVE_WEIGHTS } from './drives.js';

describe('DrizzleProactiveOutcomeStore', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let rewards: DrizzleProactiveOutcomeStore;
  let proposalId: string;

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
    rewards = new DrizzleProactiveOutcomeStore(db);
    const proposal = await new DrizzleProposalStore(db).create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://x.dev' },
      summary: 'Remember https://x.dev',
      origin: 'autonomous',
    });
    proposalId = proposal.id;
  });
  afterEach(async () => {
    await close();
  });

  it('records an outcome, finds it by proposal, and resolves its reward', async () => {
    const outcome = await rewards.record(companionId, {
      proposalId,
      drive: 'curiosity',
      driveSnapshot: DEFAULT_DRIVE_WEIGHTS,
    });
    expect(outcome.reward).toBeNull();
    expect(outcome.drive).toBe('curiosity');

    const found = await rewards.findByProposal(companionId, proposalId);
    expect(found?.id).toBe(outcome.id);

    await rewards.setReward(companionId, outcome.id, 1);
    const resolved = await rewards.findByProposal(companionId, proposalId);
    expect(resolved?.reward).toBe(1);
    expect(resolved?.resolvedAt).not.toBeNull();
  });

  it('does not set the reward for another companion (tenancy invariant)', async () => {
    const outcome = await rewards.record(companionId, { proposalId, drive: 'curiosity' });

    await rewards.setReward('00000000-0000-0000-0000-000000000000', outcome.id, 1);

    const found = await rewards.findByProposal(companionId, proposalId);
    expect(found?.reward).toBeNull();
    expect(found?.resolvedAt).toBeNull();
  });

  it('returns null for a proposal with no outcome', async () => {
    expect(
      await rewards.findByProposal(companionId, '00000000-0000-0000-0000-000000000000'),
    ).toBeNull();
  });

  it('lists outcomes newest-first', async () => {
    await rewards.record(companionId, { proposalId, drive: 'curiosity' });
    await rewards.record(companionId, { proposalId, drive: 'bond' });
    const list = await rewards.list(companionId, 10);
    expect(list).toHaveLength(2);
    expect(list[0]!.drive).toBe('bond'); // newest first
  });
});
