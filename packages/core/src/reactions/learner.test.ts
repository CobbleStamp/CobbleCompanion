/**
 * Reaction learning — the will's half (companion-reactions.md §4). A user reaction
 * is read for the VALUE it signals, then attributed: a reaction on a proactive
 * note resolves that outcome and nudges its served drive (by note_message_id, the
 * addressed path); a reaction on an ordinary answer nudges `approval` gently; a
 * null read teaches nothing; and an already-resolved outcome is never double-scored.
 * The billed read is gated on the stamina wallet (empty → no read), and an
 * un-react → re-react toggle of the same emoji is debounced (no re-bill, no re-nudge).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { MessageDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { FakeLlmGateway } from '../llm/fake.js';
import type { ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { resolveWeights } from '../motivation/drives.js';
import { DrizzleProactiveOutcomeStore } from '../motivation/reward-store.js';
import { DrizzleVitalityStore } from '../quota/vitality-store.js';
import { DrizzleUserModelStore } from '../user-model/store.js';
import { ReactionLearner } from './learner.js';
import { asReactableMessage, type ReactableMessage } from './reactable.js';
import { DrizzleReactionStore } from './store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const NEUTRAL = resolveWeights(null);

function reportReaction(reward: number, note = 'ok'): readonly [{ toolCalls: ToolCall[] }] {
  return [{ toolCalls: [{ name: 'report_reaction', args: { reward, note } }] }];
}

/** Parse a test message into the proof-carrying type `learn()` requires. */
function reactable(message: MessageDto): ReactableMessage {
  const parsed = asReactableMessage(message);
  if (!parsed) {
    throw new Error('test message is not reactable');
  }
  return parsed;
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
    learner.learn(reactable(note), '❤️');
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
    learner.learn(reactable(msg), '👍');
    await learner.whenIdle();

    expect(await approvalWeight()).toBeGreaterThan(NEUTRAL.approval);
    // No outcome existed, so nothing in the reward log was resolved.
    expect(await rewards.list(companionId, 5)).toHaveLength(0);
  });

  it('a null read teaches nothing — no nudge, no recorded reward', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');

    const learner = learnerFor(null);
    learner.learn(reactable(msg), '👍');
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
    learner.learn(reactable(note), '😐');
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
    learner.learn(reactable(note), '❤️');
    await learner.whenIdle();

    const [current] = await userModel.listCurrentBeliefs(userId);
    expect(current?.salience).toBeGreaterThan(0.5); // 0.5 + 0.1·0.8
  });

  it('does not fire the billed read when the stamina wallet is empty', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');
    const stamina = new DrizzleVitalityStore(db, 'stamina');
    await stamina.spend(companionId, Number.MAX_SAFE_INTEGER); // drain the seed

    const llm = new FakeLlmGateway(reportReaction(0.6));
    const learner = new ReactionLearner({
      rewards,
      reactions,
      identity,
      memory,
      userModel,
      sense: { llm, model: 'fake', logger: silent, quota: stamina },
      logger: silent,
    });
    learner.learn(reactable(msg), '👍');
    await learner.whenIdle();

    // The gate held: no LLM call was made, nothing was recorded or nudged.
    expect(llm.calls).toHaveLength(0);
    expect(await approvalWeight()).toBeCloseTo(NEUTRAL.approval);
    const rows = await reactions.listForMessages(companionId, [msg.id]);
    expect(rows[0]?.reward).toBeNull();
  });

  it('learns normally when the metered wallet has balance', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');
    const stamina = new DrizzleVitalityStore(db, 'stamina');
    await stamina.add(companionId, 100_000); // guarantee a non-empty wallet

    const llm = new FakeLlmGateway(reportReaction(0.6));
    const learner = new ReactionLearner({
      rewards,
      reactions,
      identity,
      memory,
      userModel,
      sense: { llm, model: 'fake', logger: silent, quota: stamina },
      logger: silent,
    });
    learner.learn(reactable(msg), '👍');
    await learner.whenIdle();

    expect(llm.calls).toHaveLength(1);
    expect(await approvalWeight()).toBeGreaterThan(NEUTRAL.approval);
  });

  it('does not re-learn an un-react → re-react toggle of the same emoji', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');
    const llm = new FakeLlmGateway(reportReaction(0.6));
    const learner = new ReactionLearner({
      rewards,
      reactions,
      identity,
      memory,
      userModel,
      sense: { llm, model: 'fake', logger: silent },
      logger: silent,
    });
    learner.learn(reactable(msg), '👍');
    await learner.whenIdle();
    const afterFirst = await approvalWeight();
    expect(llm.calls).toHaveLength(1);

    // Toggle: un-react deletes the row (reward and all), re-add re-inserts fresh
    // and the route fires learn() again — the debounce must absorb the repeat.
    await reactions.remove(companionId, msg.id, 'user', '👍');
    await reactions.add(companionId, msg.id, 'user', '👍');
    learner.learn(reactable(msg), '👍');
    await learner.whenIdle();

    expect(llm.calls).toHaveLength(1); // no second billed read
    expect(await approvalWeight()).toBeCloseTo(afterFirst); // no second nudge
  });

  it('a different emoji on the same message is a distinct signal and still learns', async () => {
    const msg = await memory.appendMessage(companionId, 'assistant', 'the answer');
    await reactions.add(companionId, msg.id, 'user', '👍');
    const llm = new FakeLlmGateway(reportReaction(0.6));
    const learner = new ReactionLearner({
      rewards,
      reactions,
      identity,
      memory,
      userModel,
      sense: { llm, model: 'fake', logger: silent },
      logger: silent,
    });
    learner.learn(reactable(msg), '👍');
    await learner.whenIdle();
    const afterFirst = await approvalWeight();

    await reactions.add(companionId, msg.id, 'user', '🎉');
    learner.learn(reactable(msg), '🎉');
    await learner.whenIdle();

    expect(llm.calls).toHaveLength(2);
    expect(await approvalWeight()).toBeGreaterThan(afterFirst);
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
    learner.learn(reactable(note), '❤️');
    await learner.whenIdle();

    // The claim fails, so the reaction does not move the weight a second time.
    expect(await curiosityWeight()).toBeCloseTo(NEUTRAL.curiosity);
    const [resolved] = await rewards.list(companionId, 1);
    expect(resolved?.reward).toBeCloseTo(0.5); // unchanged by the reaction
  });
});
