/**
 * The motivation engine (Phase 4.1, companion-motivation.md) — the "will" that
 * fills the `Initiator` seam. On each tick it reads the companion's drives ×
 * environment (presence) and either stays idle (free) or runs a bounded proactive
 * burst. The one behaviour shipped is working the reading-list inventory: the
 * burst actually READS the leads into memory — no approval, autonomy is autonomy
 * (§4.4) — spending real tokens billed to the ENERGY pool, then posts one
 * in-character "what I read" note (the reward surface, §7). When energy is
 * exhausted the engine stops initiating while chat keeps running on stamina
 * (§4.8). Never throws — a failed tick is logged and swallowed (mirrors the
 * consolidation service).
 */

import type { Logger } from '../logging.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { MemoryStore } from '../memory/store.js';
import type { CompanionEnergyStore } from '../quota/energy-store.js';
import type { IdentityStore } from '../identity/store.js';
import type { IngestionTarget } from '../ingestion/runner.js';
import type { LeadStore } from '../tools/lead-store.js';
import { DEFAULT_KNOBS, decideMove, type Move } from './arbitration.js';
import { computeDrives, resolveWeights } from './drives.js';
import type { ProactiveOutcomeStore } from './reward-store.js';
import { classifyPresence, type PresenceThresholds } from './presence.js';
import type { PresenceStore } from './presence-store.js';
import { runAutonomousBurst, type AutonomousIngestStore } from './autonomous-burst.js';

export interface MotivationEngineDeps {
  readonly identity: IdentityStore;
  readonly presence: PresenceStore;
  readonly energy: CompanionEnergyStore;
  readonly leads: LeadStore;
  /** Registers + tracks the reads the burst performs (the semantic store). */
  readonly semantic: AutonomousIngestStore;
  /** Runs a source end-to-end (the ingestion pipeline) — billed to energy. */
  readonly pipeline: IngestionTarget;
  /** Transcript — where the "what I read" report note is posted. */
  readonly memory: MemoryStore;
  /** Reinforcement log — one outcome per initiation, reward filled on reaction. */
  readonly rewards: ProactiveOutcomeStore;
  /** Voices the report note; billed to energy. */
  readonly llm: LlmGateway;
  /** Cheap model for the report note (reuse the ingestion model). */
  readonly model: string;
  readonly logger: Logger;
}

export interface MotivationEngineOptions {
  readonly now?: () => Date;
  readonly thresholds?: PresenceThresholds;
}

export interface MotivationTickResult {
  readonly initiated: boolean;
  readonly move: Move | null;
  /** Sources actually read into memory this burst. */
  readonly sourcesRead: number;
  /** Real tokens billed to the energy pool this tick (reads + the note). */
  readonly energySpent: number;
}

const IDLE: MotivationTickResult = {
  initiated: false,
  move: null,
  sourcesRead: 0,
  energySpent: 0,
};

export class MotivationEngine {
  private readonly now: () => Date;
  private readonly thresholds: PresenceThresholds | undefined;

  constructor(
    private readonly deps: MotivationEngineDeps,
    options: MotivationEngineOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.thresholds = options.thresholds;
  }

  /**
   * Consider initiating for one companion. Returns what it decided (for tests and
   * logging); the runner ignores the return. Never throws.
   */
  async tick(companionId: string): Promise<MotivationTickResult> {
    const { identity, presence, energy, leads, logger } = this.deps;
    try {
      const companion = await identity.getCompanionById(companionId);
      if (!companion) {
        return IDLE;
      }

      // Cheap, token-free sensing — so staying idle is free.
      const signal = presence.get(companionId);
      const presenceState = signal
        ? classifyPresence(signal, this.now(), this.thresholds)
        : 'absent_long';
      const newLeads = await leads.listByStatus(companionId, ['new']);
      const levels = computeDrives({ newLeadCount: newLeads.length });
      const energyExhausted = await energy.isExhausted(companionId);
      const weights = resolveWeights(companion.driveWeights);

      const move = decideMove({
        levels,
        weights,
        presence: presenceState,
        dial: companion.proactivityDial,
        energyExhausted,
        knobs: companion.personalityKnobs ?? DEFAULT_KNOBS,
      });
      if (!move) {
        return IDLE; // idle is free — no energy spent
      }

      // Measure real spend as the energy delta across the burst (reads + note).
      const before = (await energy.getEnergy(companionId)).usedTokens;
      const result = await runAutonomousBurst(
        {
          leads,
          semantic: this.deps.semantic,
          pipeline: this.deps.pipeline,
          energy,
          memory: this.deps.memory,
          rewards: this.deps.rewards,
          llm: this.deps.llm,
          model: this.deps.model,
          logger,
        },
        {
          companionId,
          companion: {
            name: companion.name,
            form: companion.form,
            temperament: companion.temperament,
            evolvedPersona: companion.evolvedPersona,
          },
          drive: move.drive,
          weights,
          limit: move.limit,
        },
      );
      const energySpent = Math.max(0, (await energy.getEnergy(companionId)).usedTokens - before);
      logger.info('motivation tick initiated', {
        companionId,
        move: move.kind,
        drive: move.drive,
        sourcesRead: result.read.length,
        energySpent,
      });
      return {
        initiated: result.read.length > 0,
        move,
        sourcesRead: result.read.length,
        energySpent,
      };
    } catch (error) {
      logger.error('motivation tick failed', { companionId, error });
      return IDLE;
    }
  }
}
