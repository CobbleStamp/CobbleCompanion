/**
 * Reaction learning — the will's half (companion-reactions.md §4). A user reaction
 * is read for the VALUE it signals, then attributed: a reaction on a proactive
 * note resolves that outcome and nudges its served drive (by note_message_id, the
 * addressed path); a reaction on an ordinary answer nudges `approval` gently; a
 * null read teaches nothing; and an already-resolved outcome is never double-scored.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { FakeLlmGateway } from '../llm/fake.js';
import type { ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { resolveWeights } from '../motivation/drives.js';
import { DrizzleProactiveOutcomeStore } from '../motivation/reward-store.js';
import { DrizzleUserModelStore } from '../user-model/store.js';
import { ReactionLearner } from './learner.js';
import { DrizzleReactionStore } from './store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const NEUTRAL = resolveWeights(null);

function reportReaction(reward: number, note = 'ok'): readonly [{ toolCalls: ToolCall[] }] {
  return [{ toolCalls: [{ name: 'report_reaction', args: { reward, note } }] }];
}

describe('ReactionLearner', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let userId: string;
  let identity: DrizzleIdentityStore;
  let memory: TranscriptMemoryStore;
  let rewards: DrizzleProactiveOutcomeStore;
  let reactions: DrizzleReactionStore;
  let userModel: DrizzleUserModelStore;

  /** A learner whose read returns `reward`, or null (no tool call) when reward is null. */
  function learnerFor(reward: number | null): ReactionLearner {
    const llm =
      reward === null
        ? new FakeLlmGateway(['no tool call here'])
        : new FakeLlmGateway(reportReaction(reward));
    return new ReactionLearner({
      rewards,
      reactions,
      identity,
      memory,
      userModel,
      sense: { llm, model: 'fake', logger: silent },
      logger: silent,
    });
  }

  async function curiosityWeight(): Promise<number> {
    const companion = await identity.getCompanionById(companionId);
    return resolveWeights(companion?.driveWeights ?? null).curiosity;
  }
  async function approvalWeight(): Promise<number> {
    const companion = await identity.getCompanionById(companionId);
    return resolveWeights(companion?.driveWeights ?? null).approval;
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    memory = new TranscriptMemoryStore(db);
    rewards = new DrizzleProactiveOutcomeStore(db);
    reactions = new DrizzleReactionStore(db);
    userModel = new DrizzleUserModelStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });
  afterEach(async () => {
    await close();
  });

  it('resolves a proactive note outcome by message id and nudges its served drive', async () => {
    const note = await memory.appendMessage(companionId, 'assistant', 'I read two pieces on X.');
    const outcome = await rewards.record(companionId, {
      noteMessageId: note.id,
      drive: 'curiosity',
    });
    await reactions.add(companionId, note.id, 'user', '❤️');

    const learner = learnerFor(0.8);
    learner.learn(companionId, note.id, '❤️');
    await learner.whenIdle();

    // The outcome is resolved with the value-created reward.
    const [resolved] = await rewards.list(companionId, 1);
    expect(resolved?.id).toBe(outcome.id);
    expect(resolved?.reward).toBeCloseTo(0.8);
    // Its served drive (curiosity) rose above neutral.
    expect(await curiosityWeight()).toBeGreaterThan(NEUTRAL.curiosity);
    // The reaction row recorded the reward + note (the reflection corpus).
    const rows = await reactions.listForMessages(companionId, [note.id]);
    expect(rows[0]?.reward).toBeCloseTo(0.8);
    expect(rows[0]?.rewardNote).toBe('ok');
  });

  it('nudges the approval drive on an ordinary-answer reaction (no outcome)', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'here is the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');

    const learner = learnerFor(0.6);
    learner.learn(companionId, msg.id, '👍');
    await learner.whenIdle();

    expect(await approvalWeight()).toBeGreaterThan(NEUTRAL.approval);
    // No outcome existed, so nothing in the reward log was resolved.
    expect(await rewards.list(companionId, 5)).toHaveLength(0);
  });

  it('a null read teaches nothing — no nudge, no recorded reward', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');

    const learner = learnerFor(null);
    learner.learn(companionId, msg.id, '👍');
    await learner.whenIdle();

    expect(await approvalWeight()).toBeCloseTo(NEUTRAL.approval);
    const rows = await reactions.listForMessages(companionId, [msg.id]);
    expect(rows[0]?.reward).toBeNull();
  });

  it('a neutral (0) reward resolves the outcome but moves no personality', async () => {
    const note = await memory.appendMessage(companionId, 'assistant', 'a note');
    await rewards.record(companionId, { noteMessageId: note.id, drive: 'curiosity' });
    await reactions.add(companionId, note.id, 'user', '😐');

    const learner = learnerFor(0);
    learner.learn(companionId, note.id, '😐');
    await learner.whenIdle();

    const [resolved] = await rewards.list(companionId, 1);
    expect(resolved?.reward).toBe(0);
    expect(await curiosityWeight()).toBeCloseTo(NEUTRAL.curiosity);
  });

  it('a welcomed belief-driven note reaction also strengthens the driving belief', async () => {
    const belief = await userModel.recordBelief({
      userId,
      predicate: 'interestedIn',
      object: 'Rust',
    });
    const note = await memory.appendMessage(companionId, 'assistant', 'I read up on Rust.');
    await rewards.record(companionId, {
      noteMessageId: note.id,
      drive: 'curiosity',
      drivenByUserFactId: belief.id,
    });
    await reactions.add(companionId, note.id, 'user', '❤️');

    const learner = learnerFor(0.8);
    learner.learn(companionId, note.id, '❤️');
    await learner.whenIdle();

    const [current] = await userModel.listCurrentBeliefs(userId);
    expect(current?.salience).toBeGreaterThan(0.5); // 0.5 + 0.1·0.8
  });

  it('does not double-score an outcome already resolved by the ambient delta', async () => {
    const note = await memory.appendMessage(companionId, 'assistant', 'a note');
    const outcome = await rewards.record(companionId, {
      noteMessageId: note.id,
      drive: 'curiosity',
    });
    // Simulate the ambient affect delta having already scored it.
    await rewards.setReward(companionId, outcome.id, 0.5);
    await reactions.add(companionId, note.id, 'user', '❤️');

    const learner = learnerFor(0.9);
    learner.learn(companionId, note.id, '❤️');
    await learner.whenIdle();

    // The claim fails, so the reaction does not move the weight a second time.
    expect(await curiosityWeight()).toBeCloseTo(NEUTRAL.curiosity);
    const [resolved] = await rewards.list(companionId, 1);
    expect(resolved?.reward).toBeCloseTo(0.5); // unchanged by the reaction
  });
});
