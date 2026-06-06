/**
 * The four mirror axes (knowledge, bond, initiative, character) as PURE functions
 * over the {@link GrowthSubstrate} and {@link GrowthConfig} (development-plan.md §3).
 * Each turns a raw measure into an {@link AxisReading} — a band INDEX (for the
 * once-only reflection mark), a descriptive band name, and an intra-band fill for the
 * gauge. These are readouts, not levels: an axis may move in either direction. No I/O,
 * so they are trivially testable and deterministic; the `GrowthService` gathers the
 * substrate and these turn it into readings.
 */

import type { DriveWeights } from '@cobble/shared';
import { DRIVES, NEUTRAL_WEIGHT, resolveWeights } from '../motivation/drives.js';
import type { GrowthConfig } from './config.js';
import type { GrowthSubstrate } from './substrate.js';

/** A band index (for the high-water mark), its descriptive name, and a 0–1 gauge fill. */
export interface AxisReading {
  readonly index: number;
  readonly band: string;
  readonly fill: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Map an accumulated point total to a band via a linear per-band width. */
function bandFromPoints(points: number, width: number, bands: readonly string[]): AxisReading {
  const maxIndex = bands.length - 1;
  const raw = Math.floor(points / width);
  const index = Math.max(0, Math.min(maxIndex, raw));
  const band = bands[index] ?? bands[0] ?? '';
  // At the top band there is no "next", so the gauge reads full.
  if (index >= maxIndex) {
    return { index: maxIndex, band, fill: 1 };
  }
  return { index, band, fill: clamp01((points - index * width) / width) };
}

/** Map a value to a band via ascending minimum thresholds (one per band). */
function bandFromThresholds(
  value: number,
  thresholds: readonly number[],
  bands: readonly string[],
): AxisReading {
  const maxIndex = bands.length - 1;
  let index = 0;
  for (let i = 0; i < thresholds.length && i <= maxIndex; i += 1) {
    if (value >= (thresholds[i] ?? Infinity)) {
      index = i;
    }
  }
  const band = bands[index] ?? bands[0] ?? '';
  if (index >= maxIndex) {
    return { index: maxIndex, band, fill: 1 };
  }
  const lo = thresholds[index] ?? 0;
  const hi = thresholds[index + 1] ?? lo;
  const fill = hi > lo ? clamp01((value - lo) / (hi - lo)) : 0;
  return { index, band, fill };
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
export function computeKnowledgeReading(
  substrate: GrowthSubstrate,
  config: GrowthConfig,
): AxisReading {
  return bandFromPoints(
    knowledgePoints(substrate, config),
    config.knowledgeBandWidth,
    config.knowledgeBands,
  );
}

/** Bond points from shared-history depth (episodes weighted by salience). */
export function bondPoints(substrate: GrowthSubstrate, config: GrowthConfig): number {
  return Math.round(
    substrate.episodeCount * config.bondEpisodePoints +
      substrate.averageSalience * config.bondSalienceScale,
  );
}

/** The bond axis — how much shared history the relationship rests on. */
export function computeBondReading(substrate: GrowthSubstrate, config: GrowthConfig): AxisReading {
  return bandFromPoints(bondPoints(substrate, config), config.bondBandWidth, config.bondBands);
}

/** The initiative axis — how much the companion has acted on its own. */
export function computeInitiativeReading(
  substrate: GrowthSubstrate,
  config: GrowthConfig,
): AxisReading {
  return bandFromThresholds(
    substrate.initiationCount,
    config.initiativeBandThresholds,
    config.initiativeBands,
  );
}

/** The character axis — how distinctly the companion's disposition has formed. */
export function computeCharacterReading(
  weights: DriveWeights | null,
  config: GrowthConfig,
): AxisReading {
  return bandFromThresholds(
    personalitySpread(weights),
    config.characterBandThresholds,
    config.characterBands,
  );
}

/**
 * How far the learned drive weights have diverged from neutral, normalized to
 * 0–1 (0 = still neutral, 1 = every drive at an extreme). The backing measure of the
 * character axis. Null weights resolve to neutral first (a never-reinforced Cobble
 * reads 0 — genuinely unformed).
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
  return clamp01(average / maxDeviation);
}
