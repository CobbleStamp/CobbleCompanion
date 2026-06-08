/**
 * Growth tuning — every constant the Phase 5 mirror readings and feeding economy
 * depend on, centralized in one named, typed object (AGENTS.md: nothing hardcoded —
 * config, never scattered literals). These are product-tuning values, not environment
 * secrets, so they live as a code constant (like `DEFAULT_DRIVE_WEIGHTS`), tunable in
 * one place. The starting vitality balance remains server config
 * (`STARTING_VITALITY_TOKENS`); only the growth/economy shape lives here.
 *
 * The four axes are MIRROR readings, not game levels: a raw measure maps to a
 * descriptive **band** (+ an intra-band fill for the gauge). Knowledge and bond map
 * by a linear points-per-band width; initiative and character map by ascending
 * thresholds. Band-name arrays double as the band ladder — index 0 is the honest
 * "empty" read.
 */

export interface GrowthConfig {
  // --- Knowledge axis (points over sources/sections/episodes → band) ---
  /** Points one ingested source contributes to knowledge. */
  readonly knowledgeSourcePoints: number;
  /** Points one retrieval section contributes to knowledge. */
  readonly knowledgeSectionPoints: number;
  /** Points one consolidated episode contributes to knowledge. */
  readonly knowledgeEpisodePoints: number;
  /** Points per band step (linear; predictable + testable). */
  readonly knowledgeBandWidth: number;
  /** The knowledge band ladder, low → high (index 0 = "empty"). */
  readonly knowledgeBands: readonly string[];

  // --- Bond axis (shared-history depth → band) ---
  /** Points one episode contributes to the bond (shared history). */
  readonly bondEpisodePoints: number;
  /** Scale applied to average episode salience (0–1) → bonus bond points. */
  readonly bondSalienceScale: number;
  /** Points per band step. */
  readonly bondBandWidth: number;
  /** The bond band ladder, low → high. */
  readonly bondBands: readonly string[];

  // --- Initiative axis (autonomous-act count → band) ---
  /** Minimum initiation count for each band (ascending; index 0 starts at 0). */
  readonly initiativeBandThresholds: readonly number[];
  /** The initiative band ladder, low → high. */
  readonly initiativeBands: readonly string[];

  // --- Character axis (personality spread 0–1 → band) ---
  /** Minimum spread (0–1) for each band (ascending; index 0 starts at 0). */
  readonly characterBandThresholds: readonly number[];
  /** The character band ladder, low → high. */
  readonly characterBands: readonly string[];

  // --- Feeding economy (food pantry — companion-economy.md) ---
  /** Count of each food type a brand-new user's pantry is seeded with. */
  readonly initialFood: number;
}

export const DEFAULT_GROWTH_CONFIG: GrowthConfig = {
  knowledgeSourcePoints: 3,
  knowledgeSectionPoints: 1,
  knowledgeEpisodePoints: 2,
  knowledgeBandWidth: 10,
  knowledgeBands: ['Sparse', 'Growing', 'Broad', 'Deep', 'Vast'],

  bondEpisodePoints: 2,
  bondSalienceScale: 10,
  bondBandWidth: 8,
  bondBands: ['New', 'Acquainted', 'Familiar', 'Close', 'Inseparable'],

  initiativeBandThresholds: [0, 1, 4, 10],
  initiativeBands: ["Hasn't ventured out yet", 'Tentative', 'Active', 'Self-directed'],

  characterBandThresholds: [0, 0.25, 0.5, 0.75],
  characterBands: ['Still forming', 'Emerging', 'Distinct', 'Strongly formed'],

  initialFood: 10,
};
