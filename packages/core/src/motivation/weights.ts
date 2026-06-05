/**
 * Drive-weight learning (companion-motivation.md §7) — how a reward moves the
 * served drive's weight, clamped to a floor (so a drive never dies to zero — the
 * exploration floor) and a ceiling. Interpretable on purpose: the weights are the
 * visible "personality" the companion is raised into, and they seed the Phase 5
 * relationship-growth axis.
 *
 * The update rule is {@link nudgeDriveWeight} (Phase 4.2): an additive nudge by a
 * *change* signal (the turn-over-turn mood delta). It replaced the earlier
 * EMA-toward-an-absolute-target rule, which was wrong for a change signal — a zero
 * delta would have pulled the weight toward zero and slowly killed the drive.
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
 * Change-as-reward update (Phase 4.2, companion-motivation.md §7). The reward is
 * the **change** in the user's mood the companion's act produced — `delta =
 * valence_now − valence_before` — so the weight moves by an **additive nudge**:
 * `w ← clamp(w + α·delta)`. Positive delta raises the weight, negative lowers it,
 * and a **zero delta is an exact no-op** — which is why a neutral reaction needs
 * no special threshold (unlike the 4.1 EMA, where a 0 target would have pulled the
 * weight toward zero). Immutable; clamped to the floor/ceiling.
 *
 * A non-finite `delta` (NaN/±Infinity) is a no-op: `clamp` can't tame NaN
 * (`Math.max(floor, NaN)` is NaN), and one NaN weight silently poisons every
 * `pressure = level × weight` in arbitration (NaN comparisons are always false, so
 * the drive can never win). Delta is finite in practice — it derives from clamped
 * valences — so this only guards the learning signal against a future bad caller.
 */
export function nudgeDriveWeight(
  current: DriveWeights,
  drive: Drive,
  delta: number,
  alpha: number = DEFAULT_LEARNING_RATE,
): DriveWeights {
  if (!Number.isFinite(delta)) {
    return current;
  }
  return {
    ...current,
    [drive]: clamp(current[drive] + alpha * delta),
  };
}
