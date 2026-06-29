/**
 * Post-turn perception + learning (Phase 4.2 affect, Phase 11–12 user-model capture),
 * extracted from the harness so the agent loop owns the turn and this owns "what the
 * turn taught". After the reply has fully streamed, it senses the user's mood and hands
 * the turn-over-turn change to the will (`reinforce`), and captures the explicit facts
 * the user stated (Tier-1 identity + Tier-2 beliefs, the latter embedded for recall).
 *
 * Both reads are best-effort and never throw — a perception hiccup must never disrupt the
 * turn that carried it (logging.md); the reply has already streamed. Each is serialized
 * behind the prior one through a per-key chain so two fast turns can't overlap the
 * read→sense→upsert window: affect per COMPANION (the mood baseline), user-facts per USER
 * (facts are shared across a user's companions). The two chains are independent, so a slow
 * capture never delays the affect read. The harness launches {@link afterTurn}'s tasks
 * fire-and-forget through its {@link BackgroundTaskGroup}.
 */

import { isTier2Predicate, type MessageDto } from '@cobble/shared';
import type { EmbeddingGateway } from '../embedding/gateway.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { isConversational } from '../memory/store.js';
import { senseAffect } from '../motivation/affect.js';
import type { CompanionAffectStore } from '../motivation/affect-store.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { captureUserFacts } from '../user-model/extractor.js';
import { beliefPhrase } from '../user-model/phrasing.js';
import type { UserModelStore } from '../user-model/store.js';

/** Recent transcript turns to give the affect/capture reads as context (Phase 4.2). */
const AFFECT_CONTEXT_TURNS = 6;
/** Confidence for a fact the user EXPLICITLY stated — high, but below a user_edit's 1.0. */
const CAPTURED_FACT_CONFIDENCE = 0.9;

/**
 * Affect-loop wiring (Phase 4.2, companion-motivation.md §7). When present, the harness
 * senses the user's mood after each turn and hands the change to the will to learn
 * from. The body senses; the will learns. Omitted = the pre-4.2 path (no affect).
 */
export interface HarnessAffect {
  readonly store: CompanionAffectStore;
  /** Cheap model for the one-shot mood read. */
  readonly model: string;
  /** Consumes the turn-over-turn change in mood (the slow loop). Optional. */
  readonly reinforce?: (companionId: string, delta: number) => Promise<void>;
}

/**
 * User-Model wiring (Phase 11, companion-memory.md §4). Optional: when present, the
 * harness injects the user's Tier-1 core profile into the persona each turn and, after
 * the reply, captures any explicit identity facts the user stated (inline salient
 * capture). Omitted = no user-model reads (the pre-Phase-11 path).
 */
export interface HarnessUserModel {
  readonly store: UserModelStore;
  /** Cheap model for the one-shot capture read (reuse the ingestion model). */
  readonly model: string;
  /**
   * Embeds explicit Tier-2 beliefs at capture so they recall by vector immediately
   * (Phase 12). Omit → beliefs are stored embedding-less and recall via FTS only until
   * the reflector back-fills them. All three must be present to embed.
   */
  readonly embeddings?: EmbeddingGateway;
  readonly embeddingModel?: string;
  readonly embeddingDimensions?: number;
}

export interface PostTurnPerceptionDeps {
  readonly gateway: LlmGateway;
  readonly logger: Logger;
  /** Spends the reads' tokens from the companion's stamina wallet; omitted = unmetered. */
  readonly quota?: VitalityStore | undefined;
  /** Affect perception + learning (Phase 4.2); omitted = no mood sensing. */
  readonly affect?: HarnessAffect | undefined;
  /** User-Model capture (Phase 11–12); omitted = no capture. */
  readonly userModel?: HarnessUserModel | undefined;
}

/** Inputs to {@link PostTurnPerception.afterTurn} — the just-finished turn. */
export interface PerceiveParams {
  readonly companionId: string;
  /** The owner whose per-user fact chain a capture serializes through. */
  readonly ownerId?: string | undefined;
  readonly userContent: string;
  /**
   * The transcript snapshot taken BEFORE the reply persisted (so the user's message is
   * still the final row); both reads draw their recent context from it.
   */
  readonly snapshot: readonly MessageDto[];
}

export class PostTurnPerception {
  private readonly gateway: LlmGateway;
  private readonly logger: Logger;
  private readonly quota: VitalityStore | undefined;
  private readonly affect: HarnessAffect | undefined;
  private readonly userModel: HarnessUserModel | undefined;
  /** Tail of the per-companion affect chain (serializes the read→sense→upsert window). */
  private readonly affectChains = new Map<string, Promise<void>>();
  /** Tail of the per-USER user-fact capture chain (facts are shared across a user's companions). */
  private readonly userFactChains = new Map<string, Promise<void>>();

  constructor(deps: PostTurnPerceptionDeps) {
    this.gateway = deps.gateway;
    this.logger = deps.logger;
    this.quota = deps.quota;
    this.affect = deps.affect;
    this.userModel = deps.userModel;
  }

  /**
   * Whether any perception is wired (so the harness only pays for the pre-reply
   * transcript snapshot when a read will actually use it).
   */
  needsSnapshot(ownerId: string | undefined): boolean {
    return Boolean(this.affect) || (Boolean(this.userModel) && ownerId !== undefined);
  }

  /**
   * Launch the post-turn reads for a finished turn, returning the chained tasks for the
   * caller to track fire-and-forget. Each is serialized behind the prior one for its key
   * (companion for affect, user for capture). Returns 0–2 self-catching promises.
   */
  afterTurn(params: PerceiveParams): readonly Promise<void>[] {
    const { companionId, ownerId, userContent, snapshot } = params;
    const tasks: Promise<void>[] = [];
    if (this.affect) {
      tasks.push(this.chainAffect(companionId, snapshot, userContent));
    }
    // Inline salient capture (Phase 11): independent of the affect chain (neither delays
    // the other), serialized per USER since user-facts are per-user.
    if (this.userModel && ownerId !== undefined) {
      tasks.push(this.chainUserFacts(ownerId, companionId, snapshot, userContent));
    }
    return tasks;
  }

  /**
   * Queue a post-turn affect read behind the companion's prior one so the
   * read→sense→upsert window can't overlap for the same companion. Each link is
   * self-catching (perceiveAndLearn never throws); the `.catch` on the prior tail
   * defends against any unexpected rejection so the chain can't wedge. The map
   * entry is cleared once this read is the tail, keeping it from growing.
   */
  private chainAffect(
    companionId: string,
    recent: readonly MessageDto[],
    userContent: string,
  ): Promise<void> {
    const prior = this.affectChains.get(companionId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.perceiveAndLearn(companionId, userContent, recent));
    this.affectChains.set(companionId, next);
    void next.finally(() => {
      if (this.affectChains.get(companionId) === next) {
        this.affectChains.delete(companionId);
      }
    });
    return next;
  }

  /**
   * Sense the user's mood from this turn and let the will learn from its change
   * (Phase 4.2, companion-motivation.md §7). Loads the prior read, senses the
   * fresh one, stores it (so the next turn has a baseline), and hands the
   * turn-over-turn `delta` to `reinforce`. The body senses; the will decides what
   * that teaches. Best-effort throughout — a perception hiccup must never disrupt
   * the turn that carried it (logging.md); the reply has already streamed.
   */
  private async perceiveAndLearn(
    companionId: string,
    userContent: string,
    recent: readonly MessageDto[],
  ): Promise<void> {
    if (!this.affect) {
      return;
    }
    try {
      // The read→sense→upsert is serialized per companion (chainAffect): this
      // runs only after the prior turn's upsert has landed, so `prior` is never a
      // stale baseline (no double-counted delta) and a late older upsert can't
      // clobber a newer reading. The upsert remains last-write-wins, which is safe
      // under this single-writer-per-companion ordering. (A second process running
      // the same companion would reintroduce the race; out of scope for the
      // single-instance PoC — see affect-store.ts.)
      const prior = await this.affect.store.get(companionId);
      const reading = await senseAffect(
        {
          llm: this.gateway,
          model: this.affect.model,
          logger: this.logger,
          ...(this.quota ? { quota: this.quota } : {}),
        },
        {
          companionId,
          recentContext: affectContext(recent),
          userText: userContent,
        },
      );
      // A non-read (provider hiccup or the model declining to report) is not
      // evidence of a neutral mood — it's no evidence. Keep the prior baseline and
      // learn nothing, so a transient failure can't fabricate a mood swing (and a
      // spurious reward) on this turn or the next.
      if (!reading) {
        return;
      }
      await this.affect.store.upsert(companionId, reading);
      // First-ever turn (no prior) has no baseline → delta 0, so nothing is
      // learned; the reading is still stored for next time.
      const delta = reading.valence - (prior?.valence ?? reading.valence);
      if (this.affect.reinforce) {
        await this.affect.reinforce(companionId, delta);
      }
    } catch (error) {
      this.logger.error('failed to perceive/learn user affect', {
        operation: 'harness.perceiveAndLearn',
        companionId,
        error,
      });
    }
  }

  /**
   * Queue a post-turn user-fact capture behind the user's prior one (per-USER, since
   * facts are shared across a user's companions). Mirrors {@link chainAffect}: each
   * link self-catches, the `.catch` on the prior tail defends against a wedge, and the
   * map entry clears once this is the tail.
   */
  private chainUserFacts(
    userId: string,
    companionId: string,
    recent: readonly MessageDto[],
    userContent: string,
  ): Promise<void> {
    const prior = this.userFactChains.get(userId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.captureAndStore(userId, companionId, recent, userContent));
    this.userFactChains.set(userId, next);
    void next.finally(() => {
      if (this.userFactChains.get(userId) === next) {
        this.userFactChains.delete(userId);
      }
    });
    return next;
  }

  /**
   * Capture the explicit facts in this turn and persist them (companion-memory.md §4).
   * The extractor reads; the store writes. Tier-1 identity attributes supersede per
   * predicate; Tier-2 beliefs (Phase 12) are embedded for hybrid recall and recorded as
   * beliefs (an identical restatement reinforces, never duplicates). Best-effort
   * throughout — a capture hiccup must never disrupt the turn that carried it
   * (logging.md); the reply has already streamed.
   */
  private async captureAndStore(
    userId: string,
    companionId: string,
    recent: readonly MessageDto[],
    userContent: string,
  ): Promise<void> {
    if (!this.userModel) {
      return;
    }
    try {
      const candidates = await captureUserFacts(
        {
          llm: this.gateway,
          model: this.userModel.model,
          logger: this.logger,
          ...(this.quota ? { quota: this.quota } : {}),
        },
        { companionId, recentContext: affectContext(recent), userText: userContent },
      );
      if (!candidates || candidates.length === 0) {
        return;
      }
      const beliefs = candidates.filter((c) => isTier2Predicate(c.predicate));
      const identity = candidates.filter((c) => !isTier2Predicate(c.predicate));

      for (const candidate of identity) {
        await this.userModel.store.recordTranscriptFact({
          userId,
          predicate: candidate.predicate,
          object: candidate.object,
          learnedByCompanionId: companionId,
          confidence: CAPTURED_FACT_CONFIDENCE,
        });
      }

      // Embed all beliefs in one call (best-effort — a null embedding still recalls via
      // FTS, so an embedding hiccup degrades rather than dropping the belief).
      const embeddings = await this.embedBeliefs(companionId, beliefs);
      for (let i = 0; i < beliefs.length; i++) {
        const candidate = beliefs[i]!;
        await this.userModel.store.recordBelief({
          userId,
          predicate: candidate.predicate,
          object: candidate.object,
          source: 'transcript',
          learnedByCompanionId: companionId,
          confidence: CAPTURED_FACT_CONFIDENCE,
          ...(embeddings?.[i] ? { embedding: embeddings[i]! } : {}),
        });
      }
    } catch (error) {
      this.logger.error('failed to capture/store user facts', {
        operation: 'harness.captureUserFacts',
        companionId,
        error,
      });
    }
  }

  /**
   * Embed each belief's text for hybrid recall, returning vectors aligned to `beliefs`
   * (or null when embedding is unconfigured or fails — beliefs then recall via FTS).
   * Best-effort: an embedding failure must not drop the captured beliefs.
   */
  private async embedBeliefs(
    companionId: string,
    beliefs: readonly { predicate: string; object: string }[],
  ): Promise<readonly (readonly number[] | undefined)[] | null> {
    const cfg = this.userModel;
    if (
      !cfg?.embeddings ||
      !cfg.embeddingModel ||
      cfg.embeddingDimensions === undefined ||
      beliefs.length === 0
    ) {
      return null;
    }
    try {
      const { vectors } = await cfg.embeddings.embed({
        // Embed the natural-language rendering (not a terse `predicate object` tag) so the
        // stored vector lives in the same register as the recall query — see beliefPhrase.
        input: beliefs.map((b) => beliefPhrase(b.predicate, b.object)),
        model: cfg.embeddingModel,
        dimensions: cfg.embeddingDimensions,
      });
      return beliefs.map((_, i) => vectors[i]);
    } catch (error) {
      this.logger.error('failed to embed captured beliefs; storing FTS-only', {
        operation: 'harness.embedBeliefs',
        companionId,
        error,
      });
      return null;
    }
  }
}

/**
 * The recent conversation rendered as context for the affect/capture reads —
 * conversational turns only (tool-step/proposal rows are UI chrome), and drop the
 * final turn — that's the user message being read, passed separately as the
 * subject. Capped to the last {@link AFFECT_CONTEXT_TURNS} so the read stays cheap.
 */
export function affectContext(recent: readonly MessageDto[]): string {
  return recent
    .filter(isConversational)
    .slice(0, -1)
    .slice(-AFFECT_CONTEXT_TURNS)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
}
