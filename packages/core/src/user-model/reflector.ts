/**
 * User-Model Reflector (Phase 12, companion-memory.md §4) — the background pass that
 * derives the user's IMPLICIT Tier-2 beliefs from the raw transcript window and reconciles
 * them against what's already known. The mirror of the Personality Evolver (it models the
 * user, not the self) and a sibling of episodic consolidation: off the request path, its
 * OWN cursor (`userFactsThroughSeq`), metered against stamina, and it NEVER throws — a
 * failed pass leaves the cursor untouched so the next trigger retries the same span.
 *
 * It reads the RAW transcript (not the filler-dropped episode summaries) because the
 * signal for an implicit belief lives in the un-summarized repetition. Pipeline per run:
 * extract candidate beliefs from the window → embed each → fetch its nearest current
 * beliefs (bounded reconciliation context) → one reconciliation read maps each candidate
 * to add / reinforce / supersede → apply through the UserModelStore (write hygiene lives
 * in one place). The transcript is canonical; the belief overlay is rebuildable.
 */

import { isTier2Predicate, type UserFactDto } from '@cobble/shared';
import type { EmbeddingGateway } from '../embedding/gateway.js';
import type { IdentityStore } from '../identity/store.js';
import { drainStream } from '../llm/drain.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import {
  REPORT_RECONCILIATION,
  REPORT_USER_BELIEFS,
  render,
  userBeliefsReconcileTemplate,
  userBeliefsReflectTemplate,
} from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { createUsageAccumulator, meteredLlmGateway, type UsageSink } from '../usage.js';
import { beliefPhrase } from './phrasing.js';
import type { UserModelStore } from './store.js';

export interface UserModelReflectorOptions {
  readonly identity: IdentityStore;
  readonly memory: MemoryStore;
  readonly store: UserModelStore;
  readonly llm: LlmGateway;
  readonly embeddings: EmbeddingGateway;
  /** Cheap model for the extract + reconcile reads. */
  readonly model: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly logger: Logger;
  /** Spends + gates the run against the companion's stamina; omit = unmetered (tests). */
  readonly quota?: VitalityStore;
  /** Don't reflect until at least this many un-reflected turns have accrued. */
  readonly minTurns?: number;
  /** Max turns reflected per run (keeps the prompt bounded). */
  readonly maxWindow?: number;
  /** Existing beliefs shown to reconciliation per candidate (bounded context). */
  readonly similarK?: number;
}

/** The interface the consolidation service triggers after a run. */
export interface UserModelReflector {
  reflect(companionId: string): Promise<void>;
}

const DEFAULT_MIN_TURNS = 6;
const DEFAULT_MAX_WINDOW = 60;
const DEFAULT_SIMILAR_K = 5;
/** Salience bump when reconciliation reinforces an existing belief. */
const REINFORCE_STEP = 0.1;

/** A belief inferred from the window, before reconciliation. */
interface BeliefCandidate {
  readonly predicate: string;
  readonly object: string;
  readonly confidence?: number;
}

type ReconcileOp = 'add' | 'reinforce' | 'supersede';
interface ReconcileDecision {
  readonly index: number;
  readonly op: ReconcileOp;
  readonly targetId?: string;
}

export class LlmUserModelReflector implements UserModelReflector {
  private readonly minTurns: number;
  private readonly maxWindow: number;
  private readonly similarK: number;

  constructor(private readonly options: UserModelReflectorOptions) {
    this.minTurns = options.minTurns ?? DEFAULT_MIN_TURNS;
    this.maxWindow = options.maxWindow ?? DEFAULT_MAX_WINDOW;
    this.similarK = options.similarK ?? DEFAULT_SIMILAR_K;
  }

  async reflect(companionId: string): Promise<void> {
    const { identity, memory, logger } = this.options;
    try {
      const companion = await identity.getCompanionById(companionId);
      if (!companion) {
        return; // deleted between trigger and run
      }
      const cursor = companion.userFactsThroughSeq;
      const window = await memory.getMessagesSince(companionId, cursor, this.maxWindow);
      if (window.length < this.minTurns) {
        return; // not enough new transcript to infer durable beliefs yet
      }
      // Empty → skip without advancing; a later sweep retries once it has stamina.
      if (this.options.quota && (await this.options.quota.isEmpty(companionId))) {
        return;
      }
      const throughSeq = window[window.length - 1]!.seq;
      const userId = companion.ownerId;

      const usage = createUsageAccumulator();
      const llm = meteredLlmGateway(this.options.llm, usage.sink);
      const candidates = await this.extract(llm, window);
      if (candidates.length === 0) {
        // Nothing inferred; advance past this span so we don't re-read it.
        await identity.advanceUserFactsThroughSeq(companionId, throughSeq);
        await this.debit(companionId, usage.total().totalTokens);
        return;
      }

      const vectors = await this.embed(candidates, usage.sink);
      const neighbours = await Promise.all(
        candidates.map((_, i) =>
          this.options.store.findSimilarBeliefs(userId, vectors[i] ?? [], this.similarK),
        ),
      );
      const decisions = await this.reconcile(llm, candidates, neighbours);
      // Only a target the model was actually shown is honoured — a hallucinated or
      // malformed id falls back to a fresh add (and never reaches the DB as a bad uuid).
      const validTargets = new Set(neighbours.flat().map((belief) => belief.id));
      await this.apply(
        userId,
        companionId,
        throughSeq,
        candidates,
        vectors,
        decisions,
        validTargets,
      );

      await identity.advanceUserFactsThroughSeq(companionId, throughSeq);
      await this.debit(companionId, usage.total().totalTokens);
    } catch (error) {
      logger.error('user-model reflection failed', {
        operation: 'user-model.reflector.reflect',
        companionId,
        error,
      });
    }
  }

  /** Phase A — infer candidate beliefs from the raw window. */
  private async extract(
    llm: LlmGateway,
    window: readonly { readonly role: string; readonly content: string; readonly kind?: string }[],
  ): Promise<readonly BeliefCandidate[]> {
    const prompt = render(userBeliefsReflectTemplate, { window: renderWindow(window) });
    const result = await drainStream(
      llm.stream({
        model: this.options.model,
        messages: prompt.messages,
        ...(prompt.tools ? { tools: prompt.tools } : {}),
        promptRef: prompt.ref,
      }),
    );
    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_USER_BELIEFS);
    return call ? coerceBeliefs(call.args) : [];
  }

  /** Phase B — map each candidate to add / reinforce / supersede against its neighbours. */
  private async reconcile(
    llm: LlmGateway,
    candidates: readonly BeliefCandidate[],
    neighbours: readonly (readonly UserFactDto[])[],
  ): Promise<ReadonlyMap<number, ReconcileDecision>> {
    const text = candidates
      .map((candidate, i) => {
        const existing = neighbours[i] ?? [];
        const lines = existing.length
          ? existing
              .map((b) => `  existing: [${b.id}] the user ${b.predicate ?? ''} "${b.object}"`)
              .join('\n')
          : '  existing: (none)';
        return `Candidate ${i}: the user ${candidate.predicate} "${candidate.object}"\n${lines}`;
      })
      .join('\n');
    const prompt = render(userBeliefsReconcileTemplate, { candidates: text });
    const result = await drainStream(
      llm.stream({
        model: this.options.model,
        messages: prompt.messages,
        ...(prompt.tools ? { tools: prompt.tools } : {}),
        promptRef: prompt.ref,
      }),
    );
    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_RECONCILIATION);
    const map = new Map<number, ReconcileDecision>();
    if (call) {
      for (const decision of coerceDecisions(call.args)) {
        map.set(decision.index, decision);
      }
    }
    return map;
  }

  /** Apply each candidate's decision; an invalid target falls back to a fresh add. */
  private async apply(
    userId: string,
    companionId: string,
    throughSeq: number,
    candidates: readonly BeliefCandidate[],
    vectors: readonly (readonly number[] | undefined)[],
    decisions: ReadonlyMap<number, ReconcileDecision>,
    validTargets: ReadonlySet<string>,
  ): Promise<void> {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const decision = decisions.get(i) ?? { index: i, op: 'add' as const };
      const target =
        decision.targetId && validTargets.has(decision.targetId) ? decision.targetId : undefined;
      if (decision.op === 'reinforce' && target) {
        const updated = await this.options.store.adjustBeliefSalience(
          userId,
          target,
          REINFORCE_STEP,
        );
        if (updated) {
          continue;
        }
      } else if (decision.op === 'supersede' && target) {
        const replaced = await this.options.store.supersedeBelief(userId, target, {
          userId,
          ...this.beliefValues(candidate, companionId, throughSeq, vectors[i]),
        });
        if (replaced) {
          continue;
        }
      }
      // add, or a reinforce/supersede whose target was stale (returned null).
      await this.options.store.recordBelief({
        userId,
        ...this.beliefValues(candidate, companionId, throughSeq, vectors[i]),
      });
    }
  }

  /** The shared belief fields for an add or a supersede replacement. */
  private beliefValues(
    candidate: BeliefCandidate,
    companionId: string,
    throughSeq: number,
    embedding: readonly number[] | undefined,
  ) {
    return {
      predicate: candidate.predicate,
      object: candidate.object,
      source: 'transcript' as const,
      learnedByCompanionId: companionId,
      learnedFromSeq: throughSeq,
      ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
      ...(embedding ? { embedding } : {}),
    };
  }

  /** Embed each candidate's text in one call; a failure degrades to no embeddings. */
  private async embed(
    candidates: readonly BeliefCandidate[],
    sink: UsageSink,
  ): Promise<readonly (readonly number[] | undefined)[]> {
    try {
      const { vectors, usage } = await this.options.embeddings.embed({
        // Same natural-language rendering used at chat-capture and recall, so a candidate
        // and the current beliefs it reconciles against share an embedding register.
        input: candidates.map((c) => beliefPhrase(c.predicate, c.object)),
        model: this.options.embeddingModel,
        dimensions: this.options.embeddingDimensions,
      });
      sink.add(usage);
      return candidates.map((_, i) => vectors[i]);
    } catch (error) {
      this.options.logger.error('failed to embed candidate beliefs; reconciling FTS-only', {
        operation: 'user-model.reflector.embed',
        error,
      });
      return candidates.map(() => undefined);
    }
  }

  /** Meter the run's tokens against the companion's stamina; best-effort (logging.md). */
  private async debit(companionId: string, totalTokens: number): Promise<void> {
    if (!this.options.quota || totalTokens <= 0) {
      return;
    }
    try {
      await this.options.quota.spend(companionId, totalTokens);
    } catch (error) {
      this.options.logger.error('failed to record user-model reflection token usage', {
        operation: 'user-model.reflector.debit',
        companionId,
        error,
      });
    }
  }
}

/** Render the window to `role: content` lines, dropping tool-step / proposal chrome. */
function renderWindow(
  window: readonly { readonly role: string; readonly content: string; readonly kind?: string }[],
): string {
  return window
    .filter((m) => (m.kind ?? 'message') === 'message')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}

/** Coerce the extract tool's args into valid Tier-2 candidates; tolerant of junk. */
export function coerceBeliefs(args: Record<string, unknown>): readonly BeliefCandidate[] {
  const raw = (args as { beliefs?: unknown }).beliefs;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: BeliefCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const attribute = (item as { attribute?: unknown }).attribute;
    const value = (item as { value?: unknown }).value;
    const confidence = (item as { confidence?: unknown }).confidence;
    if (typeof attribute !== 'string' || !isTier2Predicate(attribute)) {
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    out.push({
      predicate: attribute,
      object: value.trim(),
      ...(typeof confidence === 'number' ? { confidence } : {}),
    });
  }
  return out;
}

/** Coerce the reconcile tool's args into decisions; tolerant of junk. */
export function coerceDecisions(args: Record<string, unknown>): readonly ReconcileDecision[] {
  const raw = (args as { decisions?: unknown }).decisions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ReconcileDecision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const index = (item as { index?: unknown }).index;
    const op = (item as { op?: unknown }).op;
    const targetId = (item as { targetId?: unknown }).targetId;
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      continue;
    }
    if (op !== 'add' && op !== 'reinforce' && op !== 'supersede') {
      continue;
    }
    out.push({
      index,
      op,
      ...(typeof targetId === 'string' && targetId ? { targetId } : {}),
    });
  }
  return out;
}
