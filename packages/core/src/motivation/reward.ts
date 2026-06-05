/**
 * Reward attribution (Phase 4, companion-motivation.md §7). When the user reacts
 * to a self-directed proposal, map the reaction to a hard-signal reward (v1: no
 * LLM-critic), record it on the proactive outcome, and nudge the served drive's
 * weight — so the companion learns what lands. Best-effort: never throws, so a
 * reinforcement hiccup can't fail the approve/reject the user already made.
 */

import type { IdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { resolveWeights } from './drives.js';
import type { ProactiveOutcomeStore } from './reward-store.js';
import { updateDriveWeights } from './weights.js';

export type RewardSignal = 'approved' | 'rejected';

/** Hard-signal reward values (v1). The LLM-critic feeling-score is deferred. */
export const REWARD_BY_SIGNAL: Record<RewardSignal, number> = {
  approved: 1,
  rejected: -1,
};

export interface RewardDeps {
  readonly rewards: ProactiveOutcomeStore;
  readonly identity: IdentityStore;
  readonly logger: Logger;
}

/**
 * Attribute a reward to the outcome a proposal produced and update the served
 * drive's weight. No-op when the proposal had no autonomous outcome (e.g. a
 * chat-origin proposal never recorded one).
 */
export async function applyProposalReward(
  deps: RewardDeps,
  companionId: string,
  proposalId: string,
  signal: RewardSignal,
): Promise<void> {
  try {
    const outcome = await deps.rewards.findByProposal(companionId, proposalId);
    if (!outcome) {
      return;
    }
    const reward = REWARD_BY_SIGNAL[signal];
    await deps.rewards.setReward(outcome.id, reward);
    const companion = await deps.identity.getCompanionById(companionId);
    if (!companion) {
      return;
    }
    const next = updateDriveWeights(resolveWeights(companion.driveWeights), outcome.drive, reward);
    await deps.identity.updateDriveWeights(companionId, next);
  } catch (error) {
    deps.logger.error('failed to apply proactive reward', {
      operation: 'motivation.applyProposalReward',
      companionId,
      proposalId,
      signal,
      error,
    });
  }
}
