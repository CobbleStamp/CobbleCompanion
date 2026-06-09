/**
 * Inline salient capture (companion-memory.md §4) — the post-turn read that extracts
 * the EXPLICIT facts the user stated about themselves, the sibling of affect sensing
 * (motivation/affect.ts). One cheap structured LLM read yields a list of
 * `{ predicate, object }` candidates via the `report_user_facts` tool channel — no
 * free-text parsing. Phase 11 captured Tier-1 identity (name, where they live, …);
 * Phase 12 widens it to explicit Tier-2 beliefs (a plainly stated preference/interest/
 * opinion). This module is the perception only: it returns candidates and never
 * persists; the harness writes them through the UserModelStore, routing by tier
 * (identity → recordTranscriptFact, belief → recordBelief).
 *
 * Pure-of-persistence by design, so it doubles as the `user-extract` eval call site
 * (howto-run-evals.md). Conservative: only predicates the model was offered (Tier-1 ∪
 * Tier-2) are kept; anything else is dropped, so a stray capture can't invent a profile
 * or a belief. Implicit beliefs (no single message states them) are the reflector's job.
 * Best-effort and never throws — a perception hiccup must not disrupt the chat turn
 * (logging.md). The read rides the chat turn, so it bills STAMINA.
 */

import {
  isMultiValuedPredicate,
  isTier2Predicate,
  TIER1_PREDICATES,
  TIER2_PREDICATES,
} from '@cobble/shared';
import { drainStream } from '../llm/drain.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { render, REPORT_USER_FACTS, userExtractTemplate } from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';

/**
 * A fact the user explicitly stated, ready to persist. The `predicate` is either a
 * Tier-1 identity attribute (`name`, `livesIn`, …) or a Tier-2 belief
 * (`prefers`/`interestedIn`/…); the harness routes by tier (companion-memory.md §4).
 */
export interface UserFactCandidate {
  readonly predicate: string;
  readonly object: string;
}

export interface UserFactCaptureDeps {
  readonly llm: LlmGateway;
  /** Cheap model for the one-shot read (reuse the ingestion model). */
  readonly model: string;
  readonly logger: Logger;
  /** Bills the read to the companion's stamina; omit = unmetered (tests/eval). */
  readonly quota?: VitalityStore;
}

export interface UserFactCaptureParams {
  /** The companion whose stamina the read is billed to (the read rides its turn). */
  readonly companionId?: string;
  /** A short slice of the recent conversation, for context. */
  readonly recentContext: string;
  /** The user's latest message — the turn being read for stated identity facts. */
  readonly userText: string;
}

/** The predicates the extractor is allowed to emit (the tool's enum: Tier-1 ∪ Tier-2). */
const ALLOWED_PREDICATES: ReadonlySet<string> = new Set([...TIER1_PREDICATES, ...TIER2_PREDICATES]);

/**
 * Read the explicit identity facts in the user's latest message. Returns the
 * captured candidates (possibly empty — the user stated none), or `null` on any
 * failure or when the model declines to report. Never throws.
 */
export async function captureUserFacts(
  deps: UserFactCaptureDeps,
  params: UserFactCaptureParams,
): Promise<readonly UserFactCandidate[] | null> {
  const usage = createUsageAccumulator();
  try {
    const llm = meteredLlmGateway(deps.llm, usage.sink);
    const prompt = render(userExtractTemplate, {
      recentContext: params.recentContext,
      userText: params.userText,
    });
    const result = await drainStream(
      llm.stream({
        model: deps.model,
        messages: prompt.messages,
        ...(prompt.tools ? { tools: prompt.tools } : {}),
        promptRef: prompt.ref,
      }),
    );
    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_USER_FACTS);
    // No report_user_facts call → no usable read (null); a call with an empty list is
    // a genuine read of "nothing stated" (empty array), which the harness writes nothing for.
    return call ? coerceCandidates(call.args) : null;
  } catch (error) {
    deps.logger.error('failed to capture user facts', {
      operation: 'user-model.capture',
      companionId: params.companionId,
      error,
    });
    return null;
  } finally {
    // Bill best-effort for the tokens consumed — in `finally` so a mid-stream throw
    // still bills what was metered. The read happened regardless of what was reported;
    // a quota hiccup is our infra fault and must never void the turn (billing policy).
    if (deps.quota && params.companionId) {
      const total = usage.total().totalTokens;
      if (total > 0) {
        try {
          await deps.quota.spend(params.companionId, total);
        } catch (error) {
          deps.logger.error('failed to record user-fact capture usage', {
            operation: 'user-model.capture.bill',
            companionId: params.companionId,
            error,
          });
        }
      }
    }
  }
}

/**
 * Build candidates from the tool's parsed args. Tolerant by construction: a
 * non-array `facts`, a malformed item, a disallowed attribute (not Tier-1 ∪ Tier-2), or
 * a blank value is dropped rather than throwing. Deduped per read: a SINGULAR Tier-1
 * predicate keeps the last value if the model emits it twice (supersession then keeps
 * one current value); a MULTI-VALUED Tier-1 predicate AND every Tier-2 belief keep each
 * distinct value (so "French"/"German", or "jazz"/"rust" in one read all accrete),
 * collapsing only an exact repeat.
 */
export function coerceCandidates(args: Record<string, unknown>): readonly UserFactCandidate[] {
  const rawFacts = (args as { facts?: unknown }).facts;
  if (!Array.isArray(rawFacts)) {
    return [];
  }
  // Keyed by predicate for singular attributes (last value wins), or by
  // predicate+value for accreting ones — multi-valued Tier-1 and all Tier-2 beliefs —
  // so each distinct value survives.
  const byKey = new Map<string, UserFactCandidate>();
  for (const item of rawFacts) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const attribute = (item as { attribute?: unknown }).attribute;
    const value = (item as { value?: unknown }).value;
    if (typeof attribute !== 'string' || !ALLOWED_PREDICATES.has(attribute)) {
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const accretes = isMultiValuedPredicate(attribute) || isTier2Predicate(attribute);
    const key = accretes ? JSON.stringify([attribute, trimmed]) : attribute;
    byKey.set(key, { predicate: attribute, object: trimmed });
  }
  return [...byKey.values()];
}
