/**
 * Consolidation service — one companion's reflection run, end to end, off the
 * request path (mirrors the ingestion pipeline). Reads the un-consolidated
 * transcript tail, reflects it into episodes via the LLM, embeds them, and
 * persists them while advancing the cursor atomically. Token cost is metered
 * against the owner's daily cap and gated by it (over cap → skip, retry later).
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
import type { TokenQuotaStore } from '../quota/stamina-store.js';
import type { PersonalityEvolver } from '../personality/evolve.js';
import { consolidateWindow, type ConsolidationCandidate } from './consolidation.js';
import type { ConsolidationTarget } from './consolidation-runner.js';
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
  /** Debits + gates the run against the owner's daily cap; omit = unmetered (tests). */
  readonly quota?: TokenQuotaStore;
  /**
   * Re-synthesizes the evolved persona after new episodes form (Phase 2). Fired
   * only when the run produced episodes; self-gates + meters + never throws.
   * Omitted = consolidation without personality evolution (e.g. tests).
   */
  readonly evolver?: PersonalityEvolver;
  /** Don't reflect until at least this many un-consolidated turns have accrued. */
  readonly minTurns?: number;
  /** Max turns reflected in one run (keeps the prompt + run bounded). */
  readonly maxWindow?: number;
}

/** Wait for a meaningful span before reflecting — a single turn isn't an episode. */
const DEFAULT_MIN_TURNS = 6;
/** Consolidate at most this many turns per run; the tail drains over later runs. */
const DEFAULT_MAX_WINDOW = 60;
/** Episodes embedded per gateway call. */
const EMBED_BATCH_SIZE = 32;

export class ConsolidationService implements ConsolidationTarget {
  private readonly minTurns: number;
  private readonly maxWindow: number;

  constructor(private readonly options: ConsolidationServiceOptions) {
    this.minTurns = options.minTurns ?? DEFAULT_MIN_TURNS;
    this.maxWindow = options.maxWindow ?? DEFAULT_MAX_WINDOW;
  }

  /** Reflect one companion's pending transcript tail into episodes; never throws. */
  async consolidate(companionId: string): Promise<void> {
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
      // Over cap → skip without advancing; a later sweep retries once under cap.
      if (this.options.quota && (await this.options.quota.isOverCap(companion.ownerId))) {
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
      await this.debit(companion.ownerId, usage.total().totalTokens);
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
      const withEmbeddings: NewEpisode[] = [];
      for (let offset = 0; offset < episodes.length; offset += EMBED_BATCH_SIZE) {
        const batch = episodes.slice(offset, offset + EMBED_BATCH_SIZE);
        const { vectors, usage } = await this.options.embeddings.embed({
          input: batch.map((episode) => episode.summary),
          model: this.options.embeddingModel,
          dimensions: this.options.embeddingDimensions,
        });
        sink.add(usage);
        batch.forEach((episode, i) => {
          const vector = vectors[i];
          withEmbeddings.push(vector ? { ...episode, embedding: vector } : episode);
        });
      }
      return withEmbeddings;
    } catch (error) {
      this.options.logger.error('failed to embed episodes; storing them lexical-only', {
        operation: 'memory.consolidationService.embed',
        error,
      });
      return episodes;
    }
  }

  /** Meter the run's tokens against the owner's cap; best-effort (logging.md). */
  private async debit(ownerId: string, totalTokens: number): Promise<void> {
    if (!this.options.quota || totalTokens <= 0) {
      return;
    }
    try {
      await this.options.quota.recordUsage(ownerId, totalTokens);
    } catch (error) {
      this.options.logger.error('failed to record consolidation token usage', {
        operation: 'memory.consolidationService.debit',
        ownerId,
        error,
      });
    }
  }
}

export interface ConsolidationSweepDeps {
  readonly episodic: EpisodicMemoryStore;
  readonly runner: { request(companionId: string): void };
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
  let companionIds: readonly string[];
  try {
    companionIds = await deps.episodic.companionsNeedingConsolidation(minTurns);
  } catch (error) {
    deps.logger.error('consolidation sweep failed', {
      operation: 'memory.sweepConsolidation',
      error,
    });
    return 0;
  }
  // Isolate per companion: one bad request() must not abort the rest of the
  // worklist (the sweep is best-effort catch-up; failures are logged, not fatal).
  let requested = 0;
  for (const companionId of companionIds) {
    try {
      deps.runner.request(companionId);
      requested += 1;
    } catch (error) {
      deps.logger.error('consolidation sweep failed to request a companion', {
        operation: 'memory.sweepConsolidation',
        companionId,
        error,
      });
    }
  }
  return requested;
}
