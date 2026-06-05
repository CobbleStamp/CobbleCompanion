/**
 * Sentiment reward (Phase 4.1, companion-motivation.md §7) — the companion learns
 * the way a person does: it does something, tells the user, and reads how they
 * react. After an autonomous burst posts its "what I read" note, the user's next
 * message IS the reaction. An LLM critic rates that reaction's emotional valence
 * (pleased → +, annoyed → −, neutral/unclear → 0), and the valence updates the
 * served drive's weight by the EMA (`weights.ts`). No approve/reject button —
 * reward is sensed from natural conversation.
 *
 * Best-effort throughout: a reward hiccup must never disrupt the chat turn that
 * carried the reaction (logging.md). The critic rides on the chat turn, so its
 * tokens are billed to the user's STAMINA, not the companion's energy.
 */

import type { IdentityStore } from '../identity/store.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import type { TokenQuotaStore } from '../quota/store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';
import { resolveWeights } from './drives.js';
import type { ProactiveOutcomeStore } from './reward-store.js';
import { updateDriveWeights } from './weights.js';

/**
 * Below this magnitude a reaction is treated as neutral: the outcome is still
 * resolved (so it isn't re-scored), but the drive weight is left untouched — a
 * shrug shouldn't shift personality, and it stops the companion fishing for
 * faint praise.
 */
export const MIN_REWARD_TO_LEARN = 0.2;

export interface ConversationRewardDeps {
  readonly rewards: ProactiveOutcomeStore;
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
  readonly llm: LlmGateway;
  /** Cheap model for the one-shot sentiment read. */
  readonly model: string;
  readonly logger: Logger;
  /** Bills the critic's tokens to the user's stamina; omit = unmetered (tests). */
  readonly quota?: TokenQuotaStore;
}

/**
 * Attribute the user's reaction to the most recent unresolved proactive outcome
 * and nudge the served drive's weight. No-op when nothing is awaiting a reaction.
 */
export async function applyConversationReward(
  deps: ConversationRewardDeps,
  companionId: string,
  ownerId: string,
  reactionText: string,
): Promise<void> {
  try {
    const outcome = await deps.rewards.findLatestUnresolved(companionId);
    if (!outcome) {
      return; // nothing the companion did is awaiting a reaction
    }
    const companion = await deps.identity.getCompanionById(companionId);
    const noteText = outcome.noteMessageId
      ? await noteTextFor(deps.memory, companionId, outcome.noteMessageId)
      : '';
    const valence = await readReactionValence(deps, ownerId, noteText, reactionText);

    // Resolve the outcome with the sensed valence (0 when neutral/unclear).
    await deps.rewards.setReward(companionId, outcome.id, valence);

    // Only a clear reaction shifts personality (neutral leaves weights as-is).
    if (companion && Math.abs(valence) >= MIN_REWARD_TO_LEARN) {
      const next = updateDriveWeights(
        resolveWeights(companion.driveWeights),
        outcome.drive,
        valence,
      );
      await deps.identity.updateDriveWeights(companionId, next);
    }
  } catch (error) {
    deps.logger.error('failed to apply conversation reward', {
      operation: 'motivation.applyConversationReward',
      companionId,
      error,
    });
  }
}

/** The note's text, looked up among recent transcript turns (empty if gone). */
async function noteTextFor(
  memory: MemoryStore,
  companionId: string,
  noteMessageId: string,
): Promise<string> {
  const recent = await memory.getRecentMessages(companionId, 50);
  return recent.find((message) => message.id === noteMessageId)?.content ?? '';
}

/**
 * Rate the user's reaction to what the companion did, in [-1, 1]. An LLM critic
 * returns a single number; we parse and clamp it, defaulting to 0 (neutral) on
 * anything unparseable — ambiguity should never masquerade as a strong signal.
 * Billed to the user's stamina.
 */
async function readReactionValence(
  deps: ConversationRewardDeps,
  ownerId: string,
  noteText: string,
  reactionText: string,
): Promise<number> {
  const usage = createUsageAccumulator();
  const llm = meteredLlmGateway(deps.llm, usage.sink);
  const system =
    'You read how a user reacted to something their AI companion did on its own ' +
    'initiative, and rate the emotional valence of that reaction. Reply with ONLY a ' +
    'number from -1 to 1: 1 = clearly pleased/grateful, 0 = neutral or unclear, ' +
    '-1 = clearly annoyed/displeased. No words.';
  const user =
    (noteText ? `The companion said:\n"${noteText}"\n\n` : '') +
    `The user replied:\n"${reactionText}"\n\nValence (-1 to 1):`;

  let text = '';
  for await (const delta of llm.stream({
    model: deps.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })) {
    text += delta;
  }
  await debit(deps, ownerId, usage.total().totalTokens);
  return parseValence(text);
}

/** Parse the first signed decimal in the critic's reply; clamp to [-1, 1]; 0 if none. */
export function parseValence(text: string): number {
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return 0;
  }
  const value = Number.parseFloat(match[0]);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(-1, value));
}

/** Meter the critic's tokens against the user's stamina; best-effort (logging.md). */
async function debit(
  deps: ConversationRewardDeps,
  ownerId: string,
  totalTokens: number,
): Promise<void> {
  if (!deps.quota || totalTokens <= 0) {
    return;
  }
  try {
    await deps.quota.recordUsage(ownerId, totalTokens);
  } catch (error) {
    deps.logger.error('failed to record sentiment-critic token usage', {
      operation: 'motivation.sentimentReward.debit',
      ownerId,
      error,
    });
  }
}
