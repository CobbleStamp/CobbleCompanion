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
import type { VitalityStore } from '../quota/vitality-store.js';
import type { IdentityStore } from '../identity/store.js';
import type { IngestionTarget } from '../ingestion/runner.js';
import type { LeadStore } from '../tools/lead-store.js';
import type { UserModelStore } from '../user-model/store.js';
import { DEFAULT_KNOBS, decideMove, type Move } from './arbitration.js';
import { computeDrives, resolveWeights } from './drives.js';
import type { ProactiveOutcomeStore } from './reward-store.js';
import { classifyPresence, type PresenceThresholds } from './presence.js';
import type { PresenceStore } from './presence-store.js';
import { runAutonomousBurst, type AutonomousIngestStore } from './autonomous-burst.js';

export interface MotivationEngineDeps {
  readonly identity: IdentityStore;
  readonly presence: PresenceStore;
  readonly energy: VitalityStore;
  readonly leads: LeadStore;
  /** Registers + tracks the reads the burst performs (the semantic store). */
  readonly semantic: AutonomousIngestStore;
  /** Runs a source end-to-end (the ingestion pipeline) — billed to energy. */
  readonly pipeline: IngestionTarget;
  /** Transcript — where the "what I read" report note is posted. */
  readonly memory: MemoryStore;
  /** Reinforcement log — one outcome per initiation, reward filled on reaction. */
  readonly rewards: ProactiveOutcomeStore;
  /**
   * The user model (Phase 12). When present, the curiosity drive sources its candidate
   * topics from the user's current Tier-2 interest beliefs, and a belief-driven burst is
   * attributed to the belief it served. Omitted = no belief-driven curiosity.
   */
  readonly userModel?: UserModelStore;
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
      // Phase 12: the user's current interest beliefs lift curiosity and name the belief
      // a curiosity burst serves. A cheap DB read (no tokens), like the leads read above.
      const topInterest = await this.topInterestBelief(companion.ownerId);
      const levels = computeDrives({
        newLeadCount: newLeads.length,
        interestBeliefCount: topInterest.count,
      });
      const energyRemaining = await energy.getBalance(companionId);
      const weights = resolveWeights(companion.driveWeights);

      const move = decideMove({
        levels,
        weights,
        presence: presenceState,
        dial: companion.proactivityDial,
        energyRemaining,
        knobs: companion.personalityKnobs ?? DEFAULT_KNOBS,
      });
      if (!move) {
        return IDLE; // idle is free — no energy spent
      }

      // One note waiting (companion-motivation.md scenario B): don't stack a
      // second reward-bearing initiation while a prior act is still awaiting the
      // user's reaction. The per-turn affect delta attributes to a SINGLE
      // pending outcome (reinforce.ts); a second would mis-credit the reaction
      // and orphan a row. Reactions only *resolve* outcomes and the runner
      // drains serially (engine-runner.ts), so this check and the record inside
      // the burst can't race into two pending rows. Queried only once a move is
      // chosen, so idle ticks stay free.
      if (await this.deps.rewards.findLatestUnresolved(companionId)) {
        logger.info('motivation tick deferred; a note awaits the user reaction', {
          companionId,
          move: move.kind,
          drive: move.drive,
        });
        return IDLE;
      }

      // Measure real spend as the drop in the energy balance across the burst
      // (reads + note); nothing spent between sensing and here, so the balance read
      // above is the baseline.
      const before = energyRemaining;
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
          // Attribute a curiosity burst to the interest belief it serves, so the
          // user's reaction refines that belief's salience (the belief-learning loop).
          ...(move.drive === 'curiosity' && topInterest.id
            ? { drivenByUserFactId: topInterest.id }
            : {}),
        },
      );
      // Spend = the drop in balance across the burst (a wallet only goes down with
      // work, so this is non-negative; clamp defensively in case a concurrent feed
      // raised it mid-burst).
      const after = await energy.getBalance(companionId);
      const energySpent = Math.max(0, before - after);
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

  /**
   * The user's strongest current interest belief (`interestedIn`/`prefers`, highest
   * salience) and how many they hold — the curiosity drive's belief signal (Phase 12).
   * Best-effort: a store hiccup just yields no belief signal, never breaks the tick.
   */
  private async topInterestBelief(
    ownerId: string,
  ): Promise<{ readonly id: string | undefined; readonly count: number }> {
    if (!this.deps.userModel) {
      return { id: undefined, count: 0 };
    }
    try {
      const beliefs = await this.deps.userModel.listCurrentBeliefs(ownerId);
      const interests = beliefs.filter(
        (belief) => belief.predicate === 'interestedIn' || belief.predicate === 'prefers',
      );
      const top = [...interests].sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))[0];
      return { id: top?.id, count: interests.length };
    } catch (error) {
      this.deps.logger.error('failed to read interest beliefs; no belief signal this tick', {
        operation: 'motivation.topInterestBelief',
        ownerId,
        error,
      });
      return { id: undefined, count: 0 };
    }
  }
}
