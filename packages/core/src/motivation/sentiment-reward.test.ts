/**
 * Sentiment reward — the user's reaction to a report note becomes a valence that
 * resolves the pending outcome and nudges the served drive's weight (a clear
 * reaction moves it; a neutral one doesn't). Backed by the real store with a
 * scripted LLM critic.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { FakeLlmGateway } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DEFAULT_DRIVE_WEIGHTS, resolveWeights } from './drives.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';
import { applyConversationReward, parseValence } from './sentiment-reward.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('parseValence', () => {
  it('parses and clamps the critic reply, defaulting neutral on junk', () => {
    expect(parseValence('0.9')).toBeCloseTo(0.9);
    expect(parseValence('-1')).toBe(-1);
    expect(parseValence('2')).toBe(1); // clamped
    expect(parseValence('-5')).toBe(-1); // clamped
    expect(parseValence('the user seems happy')).toBe(0); // no number → neutral
    expect(parseValence('')).toBe(0);
  });
});

describe('applyConversationReward', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let identity: DrizzleIdentityStore;
  let memory: TranscriptMemoryStore;
  let rewards: DrizzleProactiveOutcomeStore;

  async function pendingOutcome(): Promise<void> {
    const note = await memory.appendMessage(companionId, 'assistant', 'I read two things.');
    await rewards.record(companionId, { drive: 'curiosity', noteMessageId: note.id });
  }

  function deps(llm: FakeLlmGateway) {
    return { rewards, identity, memory, llm, model: 'fake', logger: silent };
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
    memory = new TranscriptMemoryStore(db);
    rewards = new DrizzleProactiveOutcomeStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('a pleased reaction resolves the outcome and raises the served weight', async () => {
    await pendingOutcome();
    await applyConversationReward(
      deps(new FakeLlmGateway(['0.9'])),
      companionId,
      'owner',
      'Oh nice, thanks!',
    );

    const [outcome] = await rewards.list(companionId, 1);
    expect(outcome!.reward).toBeCloseTo(0.9);
    const companion = await identity.getCompanionById(companionId);
    expect(resolveWeights(companion!.driveWeights).curiosity).toBeGreaterThan(
      DEFAULT_DRIVE_WEIGHTS.curiosity,
    );
  });

  it('an annoyed reaction lowers the served weight', async () => {
    await pendingOutcome();
    await applyConversationReward(
      deps(new FakeLlmGateway(['-1'])),
      companionId,
      'owner',
      'Please stop doing that.',
    );

    const companion = await identity.getCompanionById(companionId);
    expect(resolveWeights(companion!.driveWeights).curiosity).toBeLessThan(
      DEFAULT_DRIVE_WEIGHTS.curiosity,
    );
  });

  it('a neutral reaction resolves the outcome but leaves the weight unchanged', async () => {
    await pendingOutcome();
    await applyConversationReward(deps(new FakeLlmGateway(['0'])), companionId, 'owner', 'ok');

    const [outcome] = await rewards.list(companionId, 1);
    expect(outcome!.reward).toBe(0);
    expect(outcome!.resolvedAt).not.toBeNull(); // resolved (won't be re-scored)
    const companion = await identity.getCompanionById(companionId);
    expect(companion!.driveWeights).toBeNull(); // never written — weight untouched
  });

  it('is a no-op when nothing is awaiting a reaction', async () => {
    const llm = new FakeLlmGateway(['0.9']);
    await applyConversationReward(deps(llm), companionId, 'owner', 'random chatter');
    expect(llm.calls).toHaveLength(0); // critic never even ran
    expect(await rewards.list(companionId, 10)).toHaveLength(0);
  });
});
