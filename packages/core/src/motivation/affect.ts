/**
 * Affect perception (Phase 4.2, companion-motivation.md §7) — the companion's
 * read of how the user feels, taken on every user turn inside the agent loop.
 * One cheap structured LLM read yields a **valence** in [−1, 1] (how positive the
 * user's mood is) plus a short natural-language **note** ("relieved", "frustrated,
 * terse"). The harness stores it as the rolling read of the user, feeds the prior
 * read forward to attune the next reply (fast loop), and learns from the *change*
 * in valence its own acts produce (slow loop). This module is the perception only;
 * the learning lives in the will (`reinforce.ts`).
 *
 * The read uses the gateway's structured tool-call channel — the model reports its
 * judgement as a single `report_affect` call with named `{ valence, note }` fields,
 * provider-parsed into `toolCalls[0].args`. There is no free-text parsing: a
 * malformed *field* degrades to its neutral default (still a genuine read), while a
 * missing call — or a hard failure — yields `null` (no read at all). The
 * distinction matters: absence of a read is not evidence the user feels neutral, so
 * it must never be learned from as a mood swing (`reinforce.ts`).
 *
 * Best-effort: a perception hiccup must never disrupt the chat turn (logging.md).
 * The read rides the chat turn, so its tokens bill the user's STAMINA, not energy.
 */

import type { LlmGateway, StreamResult } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { affectSenseTemplate, render, REPORT_AFFECT } from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';

/** A single read of the user's emotional state. */
export interface AffectReading {
  /** How positive the user's mood reads, −1 (distressed/annoyed) … 1 (pleased). */
  readonly valence: number;
  /** A few-word description of the mood, for attunement + interpretability. */
  readonly note: string;
}

/** The neutral default — the baseline read before any turn has been sensed. (A
 *  failed or declined read returns `null`, not this — see {@link senseAffect}.) */
export const NEUTRAL_AFFECT: AffectReading = { valence: 0, note: '' };

export interface AffectSenseDeps {
  readonly llm: LlmGateway;
  /** Cheap model for the one-shot read (reuse the ingestion model). */
  readonly model: string;
  readonly logger: Logger;
  /** Bills the read to the companion's stamina; omit = unmetered (tests). */
  readonly quota?: VitalityStore;
}

export interface AffectSenseParams {
  /**
   * The companion whose stamina the read is billed to. The affect read rides the
   * chat turn (user-initiated work), so it draws stamina (architecture.md §4.8).
   */
  readonly companionId?: string;
  /** A short slice of the recent conversation, for context. */
  readonly recentContext: string;
  /** The user's latest message — the turn being read. */
  readonly userText: string;
}

/**
 * Read the user's affect from their latest message (in recent context). Returns
 * `null` on any failure or when the model declines to report — a non-read must not
 * masquerade as a genuine neutral reading, which the will would learn from as a
 * mood swing. A reported reading (even a genuine 0) comes back as itself. Never
 * throws.
 */
export async function senseAffect(
  deps: AffectSenseDeps,
  params: AffectSenseParams,
): Promise<AffectReading | null> {
  const usage = createUsageAccumulator();
  try {
    const llm = meteredLlmGateway(deps.llm, usage.sink);
    const prompt = render(affectSenseTemplate, {
      recentContext: params.recentContext,
      userText: params.userText,
    });
    const result = await drain(
      llm.stream({
        model: deps.model,
        messages: prompt.messages,
        ...(prompt.tools ? { tools: prompt.tools } : {}),
        promptRef: prompt.ref,
      }),
    );
    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_AFFECT);

    // No report_affect call → no usable read. Return null, NOT neutral: the will
    // keeps its prior baseline rather than learning a phantom mood swing.
    return call ? coerceReading(call.args) : null;
  } catch (error) {
    deps.logger.error('failed to sense user affect', {
      operation: 'motivation.affect.sense',
      companionId: params.companionId,
      error,
    });
    return null; // a hard failure is no read at all — never a fake neutral
  } finally {
    // Bill best-effort for the tokens the round trip consumed — in `finally` so a
    // mid-stream throw still bills what was already metered. Whether or not the
    // model reported, the read happened. A quota hiccup is our infra fault and must
    // never void the outcome (logging.md, billing-crash policy).
    if (deps.quota && params.companionId) {
      const total = usage.total().totalTokens;
      if (total > 0) {
        try {
          await deps.quota.spend(params.companionId, total);
        } catch (error) {
          deps.logger.error('failed to record affect read usage', {
            operation: 'motivation.affect.bill',
            companionId: params.companionId,
            error,
          });
        }
      }
    }
  }
}

/** Run a stream to completion, discarding text deltas, and return its result. */
async function drain(stream: AsyncGenerator<string, StreamResult, void>): Promise<StreamResult> {
  let step = await stream.next();
  while (!step.done) {
    step = await stream.next();
  }
  return step.value;
}

/**
 * Build a reading from the tool's parsed args. Valence is read as a finite number
 * clamped to [−1, 1] (non-numeric → neutral 0); note is read as a trimmed string
 * (absent/blank → ''). Tolerant by construction — a malformed field degrades to
 * its neutral default rather than throwing.
 */
export function coerceReading(args: Record<string, unknown>): AffectReading {
  const rawValence = args.valence;
  const valence =
    typeof rawValence === 'number' && Number.isFinite(rawValence)
      ? Math.min(1, Math.max(-1, rawValence))
      : 0;
  const rawNote = args.note;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  return { valence, note };
}
