/**
 * Reinforcement (Phase 4.2, companion-motivation.md §7) — the WILL's half of the
 * affect loop. The harness (the body) senses the turn-over-turn *change* in the
 * user's mood and hands it here as `delta`; this attributes it to the most recent
 * unresolved drive-serving act (the report note awaiting a reaction) and nudges
 * that drive's weight by the change.
 *
 * v1 scope cut: learning fires ONLY when such a deliberate act is pending.
 * Ordinary chat still senses every turn (attunement + the rolling read) but moves
 * no weights — diffuse credit assignment across bond/understanding is deferred.
 * Best-effort throughout: a reinforcement hiccup never disrupts the chat turn that
 * carried the reaction (logging.md); the reply has already streamed.
 */

import type { IdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { resolveWeights } from './drives.js';
import type { ProactiveOutcomeStore } from './reward-store.js';
import { nudgeDriveWeight } from './weights.js';

export interface ReinforceDeps {
  readonly rewards: ProactiveOutcomeStore;
  readonly identity: IdentityStore;
  readonly logger: Logger;
}

/**
 * Attribute the mood `delta` to the pending drive-serving act and nudge its
 * drive's weight. No-op when nothing is awaiting a reaction (ordinary chat). A
 * zero delta resolves the outcome without moving personality (a neutral reaction
 * shouldn't reshape the companion). Never throws.
 */
export async function reinforceFromDelta(
  deps: ReinforceDeps,
  companionId: string,
  delta: number,
): Promise<void> {
  try {
    const outcome = await deps.rewards.findLatestUnresolved(companionId);
    if (!outcome) {
      return; // ordinary chat — nothing the companion did is awaiting a reaction
    }
    // Record the change as this outcome's reward (resolves it so it isn't re-scored).
    await deps.rewards.setReward(companionId, outcome.id, delta);
    if (delta === 0) {
      return; // a neutral change resolves the outcome but leaves personality alone
    }
    const companion = await deps.identity.getCompanionById(companionId);
    if (!companion) {
      return;
    }
    const next = nudgeDriveWeight(resolveWeights(companion.driveWeights), outcome.drive, delta);
    await deps.identity.updateDriveWeights(companionId, next);
  } catch (error) {
    deps.logger.error('failed to reinforce from affect delta', {
      operation: 'motivation.reinforceFromDelta',
      companionId,
      error,
    });
  }
}
