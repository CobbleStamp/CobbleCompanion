/**
 * Drives (Phase 4, companion-motivation.md §3) — the fixed taxonomy of what the
 * companion wants, and the cheap, token-free computation of each drive's current
 * *level* (how unsatisfied it is right now). Levels are derived from environment
 * + memory each tick; the per-companion *weights* (a learned disposition) are
 * applied during arbitration. Computing levels must stay cheap so staying idle
 * costs nothing.
 *
 * v1 exercises the **curiosity** drive only (the lead frontier), since the one
 * behaviour shipped is reading-list exploration. The other axes are defined and
 * weighted but rest at level 0 until conversational proactivity lands.
 */

import type { Drive, DriveWeights } from '@cobble/shared';

/** Each drive's current need, in [0, 1]. */
export type DriveLevels = Record<Drive, number>;

export const DRIVES: readonly Drive[] = [
  'curiosity',
  'bond',
  'understanding',
  'approval',
  'helpfulness',
  'upkeep',
];

/** Neutral starting weight — a Cobble is raised into its disposition (§7). */
export const NEUTRAL_WEIGHT = 0.5;

export const DEFAULT_DRIVE_WEIGHTS: DriveWeights = {
  curiosity: NEUTRAL_WEIGHT,
  bond: NEUTRAL_WEIGHT,
  understanding: NEUTRAL_WEIGHT,
  approval: NEUTRAL_WEIGHT,
  helpfulness: NEUTRAL_WEIGHT,
  upkeep: NEUTRAL_WEIGHT,
};

/** Number of unread leads at which curiosity saturates to 1. */
const CURIOSITY_SATURATION = 5;

/** The cheap signals drive levels are computed from (extended as drives grow). */
export interface DriveContext {
  /** How many leads sit unread in the reading list. */
  readonly newLeadCount: number;
}

/** Compute current drive levels from cheap signals. Pure; spends no tokens. */
export function computeDrives(ctx: DriveContext): DriveLevels {
  const curiosity = Math.min(1, Math.max(0, ctx.newLeadCount) / CURIOSITY_SATURATION);
  return {
    curiosity,
    bond: 0,
    understanding: 0,
    approval: 0,
    helpfulness: 0,
    upkeep: 0,
  };
}

/** Resolve a companion's weights, falling back to the neutral defaults. */
export function resolveWeights(weights: DriveWeights | null | undefined): DriveWeights {
  return weights ?? DEFAULT_DRIVE_WEIGHTS;
}
