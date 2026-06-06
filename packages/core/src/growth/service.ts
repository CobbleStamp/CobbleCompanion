/**
 * Growth service (Phase 5, development-plan.md §3) — turns the real memory/activity
 * substrate into the companion's four-axis growth standing, persists the
 * idempotent high-water mark, awards treats and posts in-character growth notes on
 * genuine transitions, and builds the surface `GrowthDto`. Growth is DERIVED every
 * call; only `treats` is stored. Posting a note on a transition reuses the
 * announcer idea (a best-effort transcript write that never breaks the caller),
 * but the note text is canned (the progression pass is token-free).
 */

import {
  abilityUnlockedNote,
  growthLevelUpNote,
  type AbilityKey,
  type DriveWeights,
  type GrowthDto,
} from '@cobble/shared';
import type { IdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import type { EpisodicMemoryStore } from '../memory/episodic-store.js';
import type { MemoryStore } from '../memory/store.js';
import type { SemanticMemoryStore } from '../memory/semantic-store.js';
import { resolveWeights } from '../motivation/drives.js';
import type { CompanionAffectStore } from '../motivation/affect-store.js';
import type { ProactiveOutcomeStore } from '../motivation/reward-store.js';
import type { ProceduralStore } from '../tools/procedural-store.js';
import type { ToolCallLog } from '../tools/tool-call-log.js';
import { abilityChecklist, abilityLabel, computeUnlocked } from './abilities.js';
import { DEFAULT_GROWTH_CONFIG, type GrowthConfig } from './config.js';
import type { GrowthStore } from './growth-store.js';
import {
  computeKnowledgeLevel,
  computeOverallStage,
  computeRelationshipLevel,
  personalitySpread,
  stageEmoji,
  type AxisLevel,
} from './levels.js';
import type { GrowthSubstrate } from './substrate.js';

/** What changed on a recompute — drives the growth notes (and is handy in tests). */
export interface GrowthTransition {
  readonly knowledgeLevelUps: number;
  readonly relationshipLevelUps: number;
  readonly newAbilities: readonly AbilityKey[];
  readonly treatsEarned: number;
  readonly stageAdvanced: boolean;
}

/** The derived view a recompute produces, used to build the DTO. */
interface GrowthView {
  readonly knowledge: AxisLevel;
  readonly relationship: AxisLevel;
  readonly unlocked: readonly AbilityKey[];
  readonly overallStage: number;
  readonly driveWeights: DriveWeights | null;
  readonly evolvedPersona: string | null;
  readonly treats: number;
  readonly substrate: GrowthSubstrate;
}

export interface GrowthServiceDeps {
  readonly identity: IdentityStore;
  readonly semantic: SemanticMemoryStore;
  readonly episodic: EpisodicMemoryStore;
  readonly procedural: ProceduralStore;
  readonly toolCallLog: ToolCallLog;
  readonly rewards: ProactiveOutcomeStore;
  readonly affect: CompanionAffectStore;
  readonly growth: GrowthStore;
  readonly memory: MemoryStore;
  readonly logger: Logger;
  readonly config?: GrowthConfig;
}

const EMPTY_TRANSITION: GrowthTransition = {
  knowledgeLevelUps: 0,
  relationshipLevelUps: 0,
  newAbilities: [],
  treatsEarned: 0,
  stageAdvanced: false,
};

export class GrowthService {
  private readonly config: GrowthConfig;

  constructor(private readonly deps: GrowthServiceDeps) {
    this.config = deps.config ?? DEFAULT_GROWTH_CONFIG;
  }

  /**
   * Recompute growth from substrate, advance the high-water mark idempotently
   * (awarding treats + posting notes exactly once on genuine forward progress),
   * and return what changed. Best-effort note posting; never throws on a note.
   */
  async recompute(companionId: string): Promise<GrowthTransition> {
    const view = await this.computeView(companionId);
    if (!view) {
      return EMPTY_TRANSITION;
    }
    const stored = await this.deps.growth.getSnapshot(companionId);

    const knowledgeLevelUps = Math.max(0, view.knowledge.level - stored.knowledgeLevel);
    const relationshipLevelUps = Math.max(0, view.relationship.level - stored.relationshipLevel);
    const newAbilities = view.unlocked.filter((key) => !stored.unlockedAbilities.includes(key));
    const stageAdvanced = view.overallStage > stored.overallStage;

    if (knowledgeLevelUps === 0 && relationshipLevelUps === 0 && newAbilities.length === 0) {
      // No forward progress — nothing to celebrate or persist.
      return EMPTY_TRANSITION;
    }

    const treatsEarned =
      (knowledgeLevelUps + relationshipLevelUps) * this.config.treatsPerLevel +
      newAbilities.length * this.config.treatsPerUnlock;

    // Monotonic target (max/union) so a transient substrate dip never rewinds the
    // mark and re-fires notes later.
    const target = {
      knowledgeLevel: Math.max(stored.knowledgeLevel, view.knowledge.level),
      relationshipLevel: Math.max(stored.relationshipLevel, view.relationship.level),
      unlockedAbilities: unionAbilities(stored.unlockedAbilities, view.unlocked),
      overallStage: Math.max(stored.overallStage, view.overallStage),
    };

    const won = await this.deps.growth.advance(companionId, stored, target, treatsEarned);
    if (!won) {
      // A concurrent recompute already advanced the mark and posted the notes.
      return EMPTY_TRANSITION;
    }

    const transition: GrowthTransition = {
      knowledgeLevelUps,
      relationshipLevelUps,
      newAbilities,
      treatsEarned,
      stageAdvanced,
    };
    await this.announce(companionId, transition, view);
    return transition;
  }

  /** Lazily recompute, then return the companion's full growth standing for the surface. */
  async snapshot(companionId: string): Promise<GrowthDto> {
    await this.recompute(companionId);
    const view = await this.computeView(companionId);
    if (!view) {
      throw new Error(`growth snapshot requested for unknown companion ${companionId}`);
    }
    return this.toDto(view);
  }

  /** Gather substrate and compute the derived view; null if the companion is gone. */
  private async computeView(companionId: string): Promise<GrowthView | null> {
    const companion = await this.deps.identity.getCompanionById(companionId);
    if (!companion) {
      return null;
    }
    const [
      counts,
      episodeCount,
      averageSalience,
      procedureCount,
      toolStats,
      outcomes,
      affect,
      stored,
    ] = await Promise.all([
      this.deps.semantic.counts(companionId),
      this.deps.episodic.countEpisodes(companionId),
      this.deps.episodic.averageSalience(companionId),
      this.deps.procedural.count(companionId),
      this.deps.toolCallLog.stats(companionId),
      this.deps.rewards.list(companionId, 1),
      this.deps.affect.get(companionId),
      this.deps.growth.getSnapshot(companionId),
    ]);

    const substrate: GrowthSubstrate = {
      sourceCount: counts.sources,
      sectionCount: counts.sections,
      episodeCount,
      averageSalience,
      procedureCount,
      distinctToolNames: toolStats.distinctNames,
      toolCallTotal: toolStats.total,
      hasAutonomousWork: outcomes.length > 0,
      hasMoodSense: affect !== null,
      driveWeights: companion.driveWeights,
      evolvedPersona: companion.evolvedPersona,
    };

    const knowledge = computeKnowledgeLevel(substrate, this.config);
    const relationship = computeRelationshipLevel(substrate, this.config);
    const unlocked = computeUnlocked(substrate);
    const overallStage = computeOverallStage(
      knowledge.level,
      relationship.level,
      unlocked.length,
      this.config,
    );
    return {
      knowledge,
      relationship,
      unlocked,
      overallStage,
      driveWeights: companion.driveWeights,
      evolvedPersona: companion.evolvedPersona,
      treats: stored.treats,
      substrate,
    };
  }

  private toDto(view: GrowthView): GrowthDto {
    return {
      knowledge: {
        level: view.knowledge.level,
        progress: view.knowledge.progress,
        detail: `${view.substrate.sourceCount} sources · ${view.substrate.episodeCount} episodes`,
      },
      relationship: {
        level: view.relationship.level,
        progress: view.relationship.progress,
        detail: `${view.substrate.episodeCount} shared episodes`,
      },
      abilities: abilityChecklist(view.unlocked),
      personality: {
        weights: resolveWeights(view.driveWeights),
        spread: personalitySpread(view.driveWeights),
        evolvedPersona: view.evolvedPersona,
      },
      overallStage: view.overallStage,
      emoji: stageEmoji(view.overallStage, this.config),
      treats: view.treats,
    };
  }

  /** Post one in-character note per kind of transition (best-effort, never throws). */
  private async announce(
    companionId: string,
    transition: GrowthTransition,
    view: GrowthView,
  ): Promise<void> {
    const notes: string[] = [];
    if (transition.knowledgeLevelUps > 0) {
      notes.push(growthLevelUpNote('Knowledge', view.knowledge.level));
    }
    if (transition.relationshipLevelUps > 0) {
      notes.push(growthLevelUpNote('Relationship', view.relationship.level));
    }
    for (const key of transition.newAbilities) {
      notes.push(abilityUnlockedNote(abilityLabel(key)));
    }
    for (const note of notes) {
      try {
        await this.deps.memory.appendMessage(companionId, 'assistant', note);
      } catch (error) {
        this.deps.logger.error('failed to post growth note', {
          operation: 'growth.announce',
          companionId,
          error,
        });
      }
    }
  }
}

/** Union two ability lists, preserving the registry display order of the new set. */
function unionAbilities(
  existing: readonly AbilityKey[],
  next: readonly AbilityKey[],
): readonly AbilityKey[] {
  const seen = new Set(existing);
  return [...existing, ...next.filter((key) => !seen.has(key))];
}
