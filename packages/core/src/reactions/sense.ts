/**
 * Reaction perception (companion-reactions.md §4, §7) — the body's "value-created"
 * read of a user's emoji reaction, the sibling of the affect read
 * (motivation/affect.ts). One cheap structured LLM call yields a **reward** in
 * [−1, 1] (how much value the companion's message created, judged from the emoji
 * IN CONTEXT — not the emoji at face value) plus a short **note**. The will
 * (reactions/learner.ts) decides what that teaches.
 *
 * Same discipline as the affect read: the judgement comes back as a single
 * `report_reaction` tool call (provider-parsed, no free-text parsing); a malformed
 * *field* degrades to its neutral default (still a genuine read), while a missing
 * call or a hard failure yields `null` — **no read at all**, which the will must
 * never learn from as a value signal (a non-read is not evidence of "no value").
 * Best-effort and never throws; the read rides the user-initiated reaction, so its
 * tokens bill the companion's STAMINA.
 */

import { drainStream } from '../llm/drain.js';
import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { reactionSenseTemplate, render, REPORT_REACTION } from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';

/** A single read of the value a reaction signals. */
export interface ReactionReading {
  /** Value created for the user, −1 (missed/annoyed) … 1 (landed/moved). */
  readonly reward: number;
  /** A few words on what the reaction signals — for the reflection corpus. */
  readonly note: string;
}

export interface ReactionSenseDeps {
  readonly llm: LlmGateway;
  /** Cheap model for the one-shot read (reuse the ingestion model, like affect). */
  readonly model: string;
  readonly logger: Logger;
  /** Bills the read to the companion's stamina; omit = unmetered (tests). */
  readonly quota?: VitalityStore;
}

export interface ReactionSenseParams {
  /** The companion whose stamina the read is billed to. */
  readonly companionId?: string;
  /** A short slice of the recent conversation, for context. */
  readonly recentContext: string;
  /** The companion message the user reacted to. */
  readonly reactedMessage: string;
  /** The emoji the user reacted with. */
  readonly emoji: string;
  /** What the companion was doing, when known (a proactive act's context). */
  readonly actContext?: string;
}

/**
 * Read the value a reaction signals. Returns `null` on any failure or when the
 * model declines to report — a non-read must not masquerade as a genuine neutral
 * (which the will would learn from as "no value created"). A reported reading
 * (even a genuine 0) comes back as itself. Never throws.
 */
export async function senseReaction(
  deps: ReactionSenseDeps,
  params: ReactionSenseParams,
): Promise<ReactionReading | null> {
  const usage = createUsageAccumulator();
  try {
    const llm = meteredLlmGateway(deps.llm, usage.sink);
    const prompt = render(reactionSenseTemplate, {
      recentContext: params.recentContext,
      reactedMessage: params.reactedMessage,
      emoji: params.emoji,
      actContext: params.actContext ?? '',
    });
    const result = await drainStream(
      llm.stream({
        model: deps.model,
        messages: prompt.messages,
        ...(prompt.tools ? { tools: prompt.tools } : {}),
        promptRef: prompt.ref,
      }),
    );
    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_REACTION);
    // No report_reaction call → no usable read. Null, NOT neutral: the will learns
    // nothing rather than recording a phantom value signal.
    return call ? coerceReactionReading(call.args) : null;
  } catch (error) {
    deps.logger.error('failed to sense reaction value', {
      operation: 'reactions.sense',
      companionId: params.companionId,
      error,
    });
    return null; // a hard failure is no read at all — never a fake neutral
  } finally {
    // Bill best-effort for the tokens consumed — in `finally` so a mid-stream throw
    // still bills what was metered. The read happened whether or not the model
    // reported; a quota hiccup is our infra fault and must not void it (logging.md).
    if (deps.quota && params.companionId) {
      const total = usage.total().totalTokens;
      if (total > 0) {
        try {
          await deps.quota.spend(params.companionId, total);
        } catch (error) {
          deps.logger.error('failed to record reaction read usage', {
            operation: 'reactions.sense.bill',
            companionId: params.companionId,
            error,
          });
        }
      }
    }
  }
}

/**
 * Build a reading from the tool's parsed args. Reward is a finite number clamped to
 * [−1, 1] (non-numeric → neutral 0); note is a trimmed string (absent/blank → '').
 * Tolerant by construction — a malformed field degrades to neutral, never throws.
 */
export function coerceReactionReading(args: Record<string, unknown>): ReactionReading {
  const rawReward = args.reward;
  const reward =
    typeof rawReward === 'number' && Number.isFinite(rawReward)
      ? Math.min(1, Math.max(-1, rawReward))
      : 0;
  const rawNote = args.note;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  return { reward, note };
}
