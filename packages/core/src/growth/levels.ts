/**
 * The smooth growth axes (knowledge, relationship), the blended overall stage, and
 * the emerged-personality spread — all PURE functions over the {@link
 * GrowthSubstrate} and {@link GrowthConfig} (development-plan.md §3). No I/O, so
 * they are trivially testable and deterministic; the `GrowthService` gathers the
 * substrate and these turn it into levels.
 */

import type { DriveWeights } from '@cobble/shared';
import { DRIVES, NEUTRAL_WEIGHT, resolveWeights } from '../motivation/drives.js';
import type { GrowthConfig } from './config.js';
import type { GrowthSubstrate } from './substrate.js';

/** A level plus the fraction (0–1) accumulated toward the next one. */
export interface AxisLevel {
  readonly level: number;
  readonly progress: number;
}

/** Turn an accumulated point total into a level + progress, capped at `maxLevel`. */
function levelFromPoints(points: number, pointsPerLevel: number, maxLevel: number): AxisLevel {
  const raw = Math.floor(points / pointsPerLevel);
  const level = Math.max(0, Math.min(maxLevel, raw));
  // At the cap there is no "next level", so progress reads full.
  if (level >= maxLevel) {
    return { level: maxLevel, progress: 1 };
  }
  const progress = (points - level * pointsPerLevel) / pointsPerLevel;
  return { level, progress: Math.max(0, Math.min(1, progress)) };
}

/** Knowledge points from what the companion has read and consolidated. */
export function knowledgePoints(substrate: GrowthSubstrate, config: GrowthConfig): number {
  return (
    substrate.sourceCount * config.knowledgeSourcePoints +
    substrate.sectionCount * config.knowledgeSectionPoints +
    substrate.episodeCount * config.knowledgeEpisodePoints
  );
}

/** The knowledge axis — how much the companion knows. */
export function computeKnowledgeLevel(substrate: GrowthSubstrate, config: GrowthConfig): AxisLevel {
  return levelFromPoints(
    knowledgePoints(substrate, config),
    config.knowledgePointsPerLevel,
    config.maxAxisLevel,
  );
}

/** Relationship points from shared-history depth (episodes weighted by salience). */
export function relationshipPoints(substrate: GrowthSubstrate, config: GrowthConfig): number {
  return Math.round(
    substrate.episodeCount * config.relationshipEpisodePoints +
      substrate.averageSalience * config.relationshipSalienceScale,
  );
}

/** The relationship axis — how much shared history the bond rests on. */
export function computeRelationshipLevel(
  substrate: GrowthSubstrate,
  config: GrowthConfig,
): AxisLevel {
  return levelFromPoints(
    relationshipPoints(substrate, config),
    config.relationshipPointsPerLevel,
    config.maxAxisLevel,
  );
}

/**
 * The blended headline stage: the two axis levels plus the count of unlocked
 * abilities, bucketed by `stagePointsPerStage` and clamped to the emoji ladder.
 */
export function computeOverallStage(
  knowledgeLevel: number,
  relationshipLevel: number,
  unlockedCount: number,
  config: GrowthConfig,
): number {
  const points = knowledgeLevel + relationshipLevel + unlockedCount;
  const stage = Math.floor(points / config.stagePointsPerStage);
  return Math.max(0, Math.min(config.stageEmoji.length - 1, stage));
}

/** The stage's emoji/badge (clamped to the ladder). */
export function stageEmoji(stage: number, config: GrowthConfig): string {
  const clamped = Math.max(0, Math.min(config.stageEmoji.length - 1, stage));
  return config.stageEmoji[clamped] ?? config.stageEmoji[0] ?? '🥚';
}

/**
 * How far the learned drive weights have diverged from neutral, normalized to
 * 0–1 (0 = still neutral, 1 = every drive at an extreme). The "personality
 * formed" reading on the emerged-character card. Null weights resolve to neutral
 * first (a never-reinforced Cobble reads 0 — genuinely unformed).
 */
export function personalitySpread(weights: DriveWeights | null): number {
  const resolved = resolveWeights(weights);
  // Max deviation from neutral on either side; normalizes the average to 0–1.
  const maxDeviation = Math.max(NEUTRAL_WEIGHT, 1 - NEUTRAL_WEIGHT);
  let total = 0;
  for (const drive of DRIVES) {
    total += Math.abs(resolved[drive] - NEUTRAL_WEIGHT);
  }
  const average = total / DRIVES.length;
  return Math.max(0, Math.min(1, average / maxDeviation));
}
