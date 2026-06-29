/**
 * Consolidation service — one companion's reflection run, end to end, off the
 * request path (mirrors the ingestion pipeline). Reads the un-consolidated
 * transcript tail, reflects it into episodes via the LLM, embeds them, and
 * persists them while advancing the cursor atomically. Token cost is metered
 * from the companion's stamina and gated by it (empty → skip, retry later).
 *
 * Never throws: a failed reflection is logged and leaves the cursor untouched,
 * so the next trigger or sweep retries the same span (failures are data, §4.7).
 * The verbatim transcript is canonical; episodes are a rebuildable overlay.
 */

import type { EmbeddingGateway } from '../embedding/gateway.js';
import type { IdentityStore } from '../identity/store.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { createUsageAccumulator, meteredLlmGateway, type UsageSink } from '../usage.js';
import { meterSpend, type VitalityStore } from '../quota/vitality-store.js';
import { embedInBatches } from '../embedding/batch.js';
import { sweepCompanions, type CompanionRequester } from '../jobs/sweep.js';
import type { PersonalityEvolver } from '../personality/evolve.js';
import type { UserModelReflector } from '../user-model/reflector.js';
import type { UserPersonaSynthesizer } from '../user-model/synthesize.js';
import { consolidateWindow, type ConsolidationCandidate } from './consolidation.js';
import type { EpisodicMemoryStore, NewEpisode } from './episodic-store.js';
import type { MemoryStore } from './store.js';

export interface ConsolidationServiceOptions {
  readonly episodic: EpisodicMemoryStore;
  readonly memory: MemoryStore;
  readonly identity: IdentityStore;
  readonly llm: LlmGateway;
  readonly embeddings: EmbeddingGateway;
  /** Cheap model for the reflection pass (input-heavy, tiny JSON out). */
  readonly consolidationModel: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly logger: Logger;
  /** Spends + gates the run against the companion's stamina; omit = unmetered (tests). */
  readonly quota?: VitalityStore;
  /**
   * Re-synthesizes the evolved persona after new episodes form (Phase 2). Fired
   * only when the run produced episodes; self-gates + meters + never throws.
   * Omitted = consolidation without personality evolution (e.g. tests).
   */
  readonly evolver?: PersonalityEvolver;
  /**
   * Derives the user's Tier-2 beliefs from the same transcript on its OWN cursor
   * (Phase 12). Fired after each run regardless of whether episodes formed — it gates
   * itself; self-meters + never throws. Omitted = consolidation without belief learning.
   */
  readonly reflector?: UserModelReflector;
  /**
   * Re-synthesizes the Tier-3 user persona after the reflector runs (Phase 13). Fired each
   * pass on its OWN cursor (re-derives only when beliefs/episodes advanced); self-gates +
   * meters + never throws. Omitted = consolidation without the user persona.
   */
  readonly userPersonaSynthesizer?: UserPersonaSynthesizer;
  /** Don't reflect until at least this many un-consolidated turns have accrued. */
  readonly minTurns?: number;
  /** Max turns reflected in one run (keeps the prompt + run bounded). */
  readonly maxWindow?: number;
}

/** Wait for a meaningful span before reflecting — a single turn isn't an episode. */
const DEFAULT_MIN_TURNS = 6;
/** Consolidate at most this many turns per run; the tail drains over later runs. */
const DEFAULT_MAX_WINDOW = 60;

/** What a consolidation trigger drives — one companion's reflection run. */
export interface ConsolidationTarget {
  consolidate(companionId: string): Promise<void>;
}

export class ConsolidationService implements ConsolidationTarget {
  private readonly minTurns: number;
  private readonly maxWindow: number;

  constructor(private readonly options: ConsolidationServiceOptions) {
    this.minTurns = options.minTurns ?? DEFAULT_MIN_TURNS;
    this.maxWindow = options.maxWindow ?? DEFAULT_MAX_WINDOW;
  }

  /**
   * Run a companion's background reflection: roll the pending transcript tail into
   * episodes, then (Phase 12) derive its Tier-2 beliefs. Both steps are independent,
   * self-gating, and never throw — the belief reflector runs on its own cursor whether
   * or not episodes formed this pass, so neither blocks the other.
   */
  async consolidate(companionId: string): Promise<void> {
    await this.consolidateEpisodes(companionId);
    if (this.options.reflector) {
      await this.options.reflector.reflect(companionId);
    }
    // Tier-3 (Phase 13): re-synthesize the user persona from the now-updated facts +
    // episodes. Runs on its own cursor (re-derives only when something advanced), after the
    // reflector so it reads the freshest beliefs. Self-gating, metered, never throws.
    if (this.options.userPersonaSynthesizer) {
      await this.options.userPersonaSynthesizer.synthesize(companionId);
    }
  }

  /** Reflect one companion's pending transcript tail into episodes; never throws. */
  private async consolidateEpisodes(companionId: string): Promise<void> {
    const { episodic, memory, identity, logger } = this.options;
    try {
      const cursor = await episodic.consolidatedThroughSeq(companionId);
      const window = await memory.getMessagesSince(companionId, cursor, this.maxWindow);
      if (window.length < this.minTurns) {
        return; // not enough new transcript to be worth a memory yet
      }
      const companion = await identity.getCompanionById(companionId);
      if (!companion) {
        return; // deleted between trigger and run
      }
      // Empty → skip without advancing; a later sweep retries once it has stamina.
      if (this.options.quota && (await this.options.quota.isEmpty(companionId))) {
        return;
      }

      const usage = createUsageAccumulator();
      const candidates: readonly ConsolidationCandidate[] = window.map((turn) => ({
        seq: turn.seq,
        role: turn.role,
        content: turn.content,
        occurredAt: turn.createdAt,
      }));
      const episodes = await consolidateWindow(
        meteredLlmGateway(this.options.llm, usage.sink),
        this.options.consolidationModel,
        { name: companion.name, form: companion.form, temperament: companion.temperament },
        candidates,
        logger,
      );

      const throughSeq = window[window.length - 1]!.seq;
      const embedded = await this.embed(episodes, usage.sink);
      // Advance the cursor to the whole window's end even when zero episodes
      // resulted (a span of pure filler), so we never re-reflect it.
      await episodic.appendEpisodes(companionId, embedded, throughSeq);
      // Meter the run's tokens against the companion's stamina; best-effort (logging.md).
      await meterSpend(this.options.quota, companionId, usage.total().totalTokens, logger, {
        message: 'failed to record consolidation token usage',
        operation: 'memory.consolidationService.debit',
      });
      // New memories formed → let the companion's character grow from them.
      // Self-gating + metered + never throws; only worth firing when episodes exist.
      if (embedded.length > 0 && this.options.evolver) {
        await this.options.evolver.evolve(companionId);
      }
    } catch (error) {
      logger.error('consolidation run failed', {
        operation: 'memory.consolidationService.consolidate',
        companionId,
        error,
      });
    }
  }

  /** Embed each episode's summary (batched); an embedding failure degrades to
   * no-embedding episodes (still recalled lexically) rather than losing them. */
  private async embed(
    episodes: readonly NewEpisode[],
    sink: UsageSink,
  ): Promise<readonly NewEpisode[]> {
    if (episodes.length === 0) {
      return episodes;
    }
    try {
      const embedded = await embedInBatches(
        this.options.embeddings,
        episodes,
        (episode) => episode.summary,
        {
          model: this.options.embeddingModel,
          dimensions: this.options.embeddingDimensions,
          sink,
        },
      );
      return embedded.map(({ item, vector }) => (vector ? { ...item, embedding: vector } : item));
    } catch (error) {
      this.options.logger.error('failed to embed episodes; storing them lexical-only', {
        operation: 'memory.consolidationService.embed',
        error,
      });
      return episodes;
    }
  }
}

export interface ConsolidationSweepDeps {
  readonly episodic: EpisodicMemoryStore;
  readonly runner: CompanionRequester;
  readonly logger: Logger;
  /** Same threshold the service enforces, so the sweep only wakes real work. */
  readonly minTurns?: number;
}

/**
 * Periodic + startup catch-up: hand every companion with a long-enough
 * un-consolidated tail to the runner (coalesced + serial + cap-gated there).
 * The service re-checks the threshold and the cap at run time, so this is
 * best-effort and idempotent. Returns how many companions were requested.
 */
export async function sweepConsolidation(deps: ConsolidationSweepDeps): Promise<number> {
  const minTurns = deps.minTurns ?? DEFAULT_MIN_TURNS;
  return sweepCompanions(
    () => deps.episodic.companionsNeedingConsolidation(minTurns),
    deps.runner,
    deps.logger,
    'memory.sweepConsolidation',
  );
}
