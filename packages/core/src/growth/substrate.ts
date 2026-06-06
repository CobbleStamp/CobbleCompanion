/**
 * The growth substrate — a point-in-time snapshot of the real memory/activity
 * tables the four growth axes are DERIVED from (development-plan.md §3). Growth is
 * never a parallel score: it is computed from these counts every time. The
 * `GrowthService` gathers this from the existing stores; the pure level/ability
 * functions read it. An object so new signals stay additive.
 */

import type { DriveWeights } from '@cobble/shared';

export interface GrowthSubstrate {
  // Knowledge axis.
  readonly sourceCount: number;
  readonly sectionCount: number;
  readonly episodeCount: number;
  // Relationship axis.
  readonly averageSalience: number;
  // Abilities (observed capabilities, from the tool/procedure/reward/affect logs).
  readonly procedureCount: number;
  readonly distinctToolNames: readonly string[];
  readonly toolCallTotal: number;
  readonly hasAutonomousWork: boolean;
  readonly hasMoodSense: boolean;
  // Personality (the emerged-character card). Null until reinforcement runs —
  // a never-reinforced Cobble reads as genuinely unformed (neutral).
  readonly driveWeights: DriveWeights | null;
  readonly evolvedPersona: string | null;
}
