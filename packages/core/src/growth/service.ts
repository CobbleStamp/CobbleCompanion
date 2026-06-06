/**
 * Growth service (Phase 5, development-plan.md §3) — turns the real memory/activity
 * substrate into the companion's four-axis growth standing as a MIRROR (knowledge,
 * bond, initiative, character), persists the idempotent high-water mark, awards treats
 * and posts in-character reflections on genuine forward progress, and builds the
 * surface `GrowthDto`. Growth is DERIVED every call and may move in either direction;
 * only `treats` is stored. The high-water mark exists ONLY so a reflection fires once
 * per band reached (it never floors what the surface shows). Posting a reflection
 * reuses the announcer idea (a best-effort transcript write that never breaks the
 * caller); the note text is canned (the progression pass is token-free).
 */

import {
  capabilityObservedNote,
  growthReflectionNote,
  type CapabilityKey,
  type CharacterDto,
  type DriveWeights,
  type GrowthDto,
} from '@cobble/shared';
import type { IdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import type { EpisodicMemoryStore } from '../memory/episodic-store.js';
import type { MemoryStore } from '../memory/store.js';
import type { SemanticMemoryStore } from '../memory/semantic-store.js';
import { DRIVE_LABELS, DRIVES, resolveWeights } from '../motivation/drives.js';
import type { CompanionAffectStore } from '../motivation/affect-store.js';
import type { ProactiveOutcomeStore } from '../motivation/reward-store.js';
import type { ProceduralStore } from '../tools/procedural-store.js';
import type { ToolCallLog } from '../tools/tool-call-log.js';
import { capabilityChecklist, capabilityLabel, computeObserved } from './capabilities.js';
import { DEFAULT_GROWTH_CONFIG, type GrowthConfig } from './config.js';
import type { GrowthStore } from './growth-store.js';
import {
  computeBondReading,
  computeCharacterReading,
  computeInitiativeReading,
  computeKnowledgeReading,
  type AxisReading,
} from './levels.js';
import type { GrowthSubstrate } from './substrate.js';

/** What changed on a recompute — drives the reflections (and is handy in tests). */
export interface GrowthTransition {
  readonly knowledgeAdvanced: boolean;
  readonly bondAdvanced: boolean;
  readonly initiativeAdvanced: boolean;
  readonly newCapabilities: readonly CapabilityKey[];
  readonly treatsEarned: number;
}

/** The derived view a recompute produces, used to build the DTO. */
interface GrowthView {
  readonly knowledge: AxisReading;
  readonly bond: AxisReading;
  readonly initiative: AxisReading;
  readonly character: AxisReading;
  readonly observed: readonly CapabilityKey[];
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
  knowledgeAdvanced: false,
  bondAdvanced: false,
  initiativeAdvanced: false,
  newCapabilities: [],
  treatsEarned: 0,
};

export class GrowthService {
  private readonly config: GrowthConfig;

  constructor(private readonly deps: GrowthServiceDeps) {
    this.config = deps.config ?? DEFAULT_GROWTH_CONFIG;
  }

  /**
   * Recompute growth from substrate, advance the high-water mark idempotently
   * (awarding treats + posting reflections exactly once per band reached), and return
   * what changed. Best-effort note posting; never throws on a note.
   */
  async recompute(companionId: string): Promise<GrowthTransition> {
    const view = await this.computeView(companionId);
    if (!view) {
      return EMPTY_TRANSITION;
    }
    const stored = await this.deps.growth.getSnapshot(companionId);

    const knowledgeSteps = Math.max(0, view.knowledge.index - stored.knowledgeBand);
    const bondSteps = Math.max(0, view.bond.index - stored.bondBand);
    const initiativeSteps = Math.max(0, view.initiative.index - stored.initiativeBand);
    const newCapabilities = view.observed.filter(
      (key) => !stored.observedCapabilities.includes(key),
    );

    if (
      knowledgeSteps === 0 &&
      bondSteps === 0 &&
      initiativeSteps === 0 &&
      newCapabilities.length === 0
    ) {
      // No forward progress — nothing to celebrate or persist. (A dip is fine: the
      // mark holds, but the surface still shows the lower live reading.)
      return EMPTY_TRANSITION;
    }

    const treatsEarned =
      (knowledgeSteps + bondSteps + initiativeSteps) * this.config.treatsPerBand +
      newCapabilities.length * this.config.treatsPerCapability;

    // Monotonic target (max/union) so a transient substrate dip never rewinds the
    // mark and re-fires reflections later.
    const target = {
      knowledgeBand: Math.max(stored.knowledgeBand, view.knowledge.index),
      bondBand: Math.max(stored.bondBand, view.bond.index),
      initiativeBand: Math.max(stored.initiativeBand, view.initiative.index),
      observedCapabilities: unionCapabilities(stored.observedCapabilities, view.observed),
    };

    const won = await this.deps.growth.advance(companionId, stored, target, treatsEarned);
    if (!won) {
      // A concurrent recompute already advanced the mark and posted the reflections.
      return EMPTY_TRANSITION;
    }

    const transition: GrowthTransition = {
      knowledgeAdvanced: knowledgeSteps > 0,
      bondAdvanced: bondSteps > 0,
      initiativeAdvanced: initiativeSteps > 0,
      newCapabilities,
      treatsEarned,
    };
    await this.announce(companionId, transition);
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
    const [counts, episodeCount, averageSalience, procedureCount, toolStats, initiative, affect] =
      await Promise.all([
        this.deps.semantic.counts(companionId),
        this.deps.episodic.countEpisodes(companionId),
        this.deps.episodic.averageSalience(companionId),
        this.deps.procedural.count(companionId),
        this.deps.toolCallLog.stats(companionId),
        this.deps.rewards.stats(companionId),
        this.deps.affect.get(companionId),
      ]);
    const stored = await this.deps.growth.getSnapshot(companionId);

    const substrate: GrowthSubstrate = {
      sourceCount: counts.sources,
      sectionCount: counts.sections,
      episodeCount,
      averageSalience,
      initiationCount: initiative.total,
      positiveReactionCount: initiative.positive,
      procedureCount,
      distinctToolNames: toolStats.distinctNames,
      toolCallTotal: toolStats.total,
      hasMoodSense: affect !== null,
      driveWeights: companion.driveWeights,
      evolvedPersona: companion.evolvedPersona,
    };

    return {
      knowledge: computeKnowledgeReading(substrate, this.config),
      bond: computeBondReading(substrate, this.config),
      initiative: computeInitiativeReading(substrate, this.config),
      character: computeCharacterReading(companion.driveWeights, this.config),
      observed: computeObserved(substrate),
      driveWeights: companion.driveWeights,
      evolvedPersona: companion.evolvedPersona,
      treats: stored.treats,
      substrate,
    };
  }

  private toDto(view: GrowthView): GrowthDto {
    const s = view.substrate;
    return {
      knowledge: {
        band: view.knowledge.band,
        fill: view.knowledge.fill,
        detail: `${s.sourceCount} ${plural(s.sourceCount, 'source')} · ${s.episodeCount} ${plural(s.episodeCount, 'memory', 'memories')}`,
      },
      bond: {
        band: view.bond.band,
        fill: view.bond.fill,
        detail: `${s.episodeCount} shared ${plural(s.episodeCount, 'episode')}`,
      },
      initiative: {
        band: view.initiative.band,
        fill: view.initiative.fill,
        detail: initiativeDetail(s),
      },
      character: this.characterDto(view),
      capabilities: capabilityChecklist(view.observed),
      treats: view.treats,
    };
  }

  /** The "Who {name} has become" card — the character band, per-drive weights, persona. */
  private characterDto(view: GrowthView): CharacterDto {
    const weights = resolveWeights(view.driveWeights);
    return {
      band: view.character.band,
      drives: DRIVES.map((key) => ({ key, label: DRIVE_LABELS[key], weight: weights[key] })),
      evolvedPersona: view.evolvedPersona,
    };
  }

  /** Post one in-character reflection per kind of transition (best-effort, never throws). */
  private async announce(companionId: string, transition: GrowthTransition): Promise<void> {
    const notes: string[] = [];
    if (transition.knowledgeAdvanced) {
      notes.push(growthReflectionNote('knowledge'));
    }
    if (transition.bondAdvanced) {
      notes.push(growthReflectionNote('bond'));
    }
    if (transition.initiativeAdvanced) {
      notes.push(growthReflectionNote('initiative'));
    }
    for (const key of transition.newCapabilities) {
      notes.push(capabilityObservedNote(capabilityLabel(key)));
    }
    for (const note of notes) {
      try {
        await this.deps.memory.appendMessage(companionId, 'assistant', note);
      } catch (error) {
        this.deps.logger.error('failed to post growth reflection', {
          operation: 'growth.announce',
          companionId,
          error,
        });
      }
    }
  }
}

/** Union two capability lists, preserving the registry display order of the new set. */
function unionCapabilities(
  existing: readonly CapabilityKey[],
  next: readonly CapabilityKey[],
): readonly CapabilityKey[] {
  const seen = new Set(existing);
  return [...existing, ...next.filter((key) => !seen.has(key))];
}

/** A short human gloss of the initiative substrate (honest when the companion hasn't ventured yet). */
function initiativeDetail(s: GrowthSubstrate): string {
  if (s.initiationCount === 0) {
    return 'no self-directed moves yet';
  }
  const ventured = `${s.initiationCount} self-directed ${plural(s.initiationCount, 'move')}`;
  return s.positiveReactionCount > 0
    ? `${ventured} · ${s.positiveReactionCount} welcomed`
    : ventured;
}

/** Pluralize a count's noun (`1 source`, `3 sources`); pass an explicit plural for irregulars. */
function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}
