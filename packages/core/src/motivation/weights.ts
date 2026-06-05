/**
 * Drive-weight learning (Phase 4, companion-motivation.md §7) — the v1
 * reinforcement update. A blended reward in [-1, 1] nudges the served drive's
 * weight by an EMA-style step, clamped to a floor (so a drive never dies to zero —
 * the exploration floor) and a ceiling. Interpretable on purpose: the weights are
 * the visible "personality" the companion is raised into, and they seed the
 * Phase 5 relationship-growth axis.
 */

import type { Drive, DriveWeights } from '@cobble/shared';

/** Learning rate — deliberately small so personality drifts, not whiplashes. */
export const DEFAULT_LEARNING_RATE = 0.1;

/** Weight bounds: a floor keeps every drive alive (exploration), capped at 1. */
export const WEIGHT_FLOOR = 0.05;
export const WEIGHT_CEILING = 1;

function clamp(value: number): number {
  return Math.min(WEIGHT_CEILING, Math.max(WEIGHT_FLOOR, value));
}

/**
 * Return a new weight vector with `drive` nudged toward `reward` (immutable —
 * `coding-style` immutability). EMA update `w ← w + α·(reward − w)`: positive
 * reward raises the weight, negative lowers it, converging toward the reward
 * value at rate `alpha`, clamped to the floor/ceiling.
 */
export function updateDriveWeights(
  current: DriveWeights,
  drive: Drive,
  reward: number,
  alpha: number = DEFAULT_LEARNING_RATE,
): DriveWeights {
  return {
    ...current,
    [drive]: clamp(current[drive] + alpha * (reward - current[drive])),
  };
}
