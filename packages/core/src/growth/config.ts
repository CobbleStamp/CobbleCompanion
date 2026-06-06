/**
 * Growth tuning — every constant the Phase 5 progression curves and feeding
 * economy depend on, centralized in one named, typed object (AGENTS.md: nothing
 * hardcoded — config, never scattered literals). These are product-tuning values,
 * not environment secrets, so they live as a code constant (like
 * `DEFAULT_DRIVE_WEIGHTS`), tunable in one place. The per-day vitality caps remain
 * server config; only the growth/economy shape lives here.
 */

export interface GrowthConfig {
  // --- Knowledge axis (curve over sources/sections/episodes) ---
  /** Points one ingested source contributes to knowledge. */
  readonly knowledgeSourcePoints: number;
  /** Points one retrieval section contributes to knowledge. */
  readonly knowledgeSectionPoints: number;
  /** Points one consolidated episode contributes to knowledge. */
  readonly knowledgeEpisodePoints: number;
  /** Points required per knowledge level (linear; predictable + testable). */
  readonly knowledgePointsPerLevel: number;

  // --- Relationship axis (curve over shared-history depth) ---
  /** Points one episode contributes to the relationship (shared history). */
  readonly relationshipEpisodePoints: number;
  /** Scale applied to average episode salience (0–1) → bonus relationship points. */
  readonly relationshipSalienceScale: number;
  /** Points required per relationship level. */
  readonly relationshipPointsPerLevel: number;

  /** Hard ceiling on any single axis level (keeps the bars bounded). */
  readonly maxAxisLevel: number;

  // --- Overall stage (blend of the two axes + ability unlocks) ---
  /** Combined points (knowledgeLevel + relationshipLevel + unlockedCount) per stage. */
  readonly stagePointsPerStage: number;
  /** Emoji/badge ladder indexed by overall stage (clamped to the last). */
  readonly stageEmoji: readonly string[];

  // --- Feeding economy (treats currency) ---
  /** Treats a brand-new companion starts with (so feeding works on day one). */
  readonly initialTreats: number;
  /** Treats granted per axis level gained. */
  readonly treatsPerLevel: number;
  /** Treats granted per ability unlocked. */
  readonly treatsPerUnlock: number;
}

export const DEFAULT_GROWTH_CONFIG: GrowthConfig = {
  knowledgeSourcePoints: 3,
  knowledgeSectionPoints: 1,
  knowledgeEpisodePoints: 2,
  knowledgePointsPerLevel: 10,

  relationshipEpisodePoints: 2,
  relationshipSalienceScale: 10,
  relationshipPointsPerLevel: 8,

  maxAxisLevel: 50,

  stagePointsPerStage: 3,
  stageEmoji: ['🥚', '🐣', '🦊', '🦊✨', '🌟', '💫'],

  initialTreats: 5,
  treatsPerLevel: 2,
  treatsPerUnlock: 1,
};
