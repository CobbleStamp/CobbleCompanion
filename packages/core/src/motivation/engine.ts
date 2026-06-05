/**
 * The motivation engine (Phase 4, companion-motivation.md) — the "will" that
 * fills the `Initiator` seam. On each tick it reads the companion's drives ×
 * environment (presence) and either stays idle (free) or runs a bounded proactive
 * burst. v1 ships one behaviour: working the reading-list inventory into
 * autonomous ingest proposals (held for approval, §4.4). Self-initiated work
 * draws the ENERGY pool, so when energy is exhausted the engine stops initiating
 * while chat keeps running on stamina (§4.8). Never throws — a failed tick is
 * logged and swallowed (mirrors the consolidation service).
 */

import type { Logger } from '../logging.js';
import type { CompanionEnergyStore } from '../quota/energy-store.js';
import type { IdentityStore } from '../identity/store.js';
import type { LeadStore } from '../tools/lead-store.js';
import type { ProposalStore } from '../tools/proposal-store.js';
import type { ToolRegistry } from '../tools/registry.js';
import { DEFAULT_KNOBS, decideMove, type Move } from './arbitration.js';
import { computeDrives, resolveWeights } from './drives.js';
import { classifyPresence, type PresenceThresholds } from './presence.js';
import type { PresenceStore } from './presence-store.js';
import { runExploreBurst } from './explore-burst.js';

/**
 * Nominal energy a single autonomous proposal costs the companion (v1 placeholder
 * for the eventual LLM judgement pass). Makes the meter move and the exhaustion
 * gate meaningful before the real burst spend lands.
 */
export const DEFAULT_ENERGY_PER_PROPOSAL = 250;

export interface MotivationEngineDeps {
  readonly identity: IdentityStore;
  readonly presence: PresenceStore;
  readonly energy: CompanionEnergyStore;
  readonly leads: LeadStore;
  readonly proposals: ProposalStore;
  readonly tools: ToolRegistry;
  readonly logger: Logger;
}

export interface MotivationEngineOptions {
  readonly now?: () => Date;
  readonly thresholds?: PresenceThresholds;
  /** Energy debited per autonomous proposal created (v1 placeholder cost). */
  readonly energyPerProposal?: number;
}

export interface MotivationTickResult {
  readonly initiated: boolean;
  readonly move: Move | null;
  readonly proposalsCreated: number;
  readonly energySpent: number;
}

const IDLE: MotivationTickResult = {
  initiated: false,
  move: null,
  proposalsCreated: 0,
  energySpent: 0,
};

export class MotivationEngine {
  private readonly now: () => Date;
  private readonly energyPerProposal: number;
  private readonly thresholds: PresenceThresholds | undefined;

  constructor(
    private readonly deps: MotivationEngineDeps,
    options: MotivationEngineOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.energyPerProposal = options.energyPerProposal ?? DEFAULT_ENERGY_PER_PROPOSAL;
    this.thresholds = options.thresholds;
  }

  /**
   * Consider initiating for one companion. Returns what it decided (for tests and
   * logging); the runner ignores the return. Never throws.
   */
  async tick(companionId: string): Promise<MotivationTickResult> {
    const { identity, presence, energy, leads, proposals, tools, logger } = this.deps;
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

      const move = decideMove({
        levels,
        weights: resolveWeights(companion.driveWeights),
        presence: presenceState,
        dial: companion.proactivityDial,
        energyExhausted,
        knobs: companion.personalityKnobs ?? DEFAULT_KNOBS,
      });
      if (!move) {
        return IDLE; // idle is free — no energy spent
      }

      const created = await runExploreBurst(
        { leads, proposals, tools },
        { companionId, origin: 'autonomous', limit: move.limit },
      );
      const energySpent = created.length * this.energyPerProposal;
      if (energySpent > 0) {
        await energy.recordSpend(companionId, energySpent);
      }
      logger.info('motivation tick initiated', {
        companionId,
        move: move.kind,
        drive: move.drive,
        proposals: created.length,
        energySpent,
      });
      return {
        initiated: created.length > 0,
        move,
        proposalsCreated: created.length,
        energySpent,
      };
    } catch (error) {
      logger.error('motivation tick failed', { companionId, error });
      return IDLE;
    }
  }
}
