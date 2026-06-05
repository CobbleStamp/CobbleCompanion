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
 * missing/malformed call simply falls back to {@link NEUTRAL_AFFECT}, so ambiguity
 * never masquerades as a strong signal.
 *
 * Best-effort: a perception hiccup must never disrupt the chat turn (logging.md).
 * The read rides the chat turn, so its tokens bill the user's STAMINA, not energy.
 */

import type { LlmGateway, StreamResult, ToolDef } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { TokenQuotaStore } from '../quota/stamina-store.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';

/** A single read of the user's emotional state. */
export interface AffectReading {
  /** How positive the user's mood reads, −1 (distressed/annoyed) … 1 (pleased). */
  readonly valence: number;
  /** A few-word description of the mood, for attunement + interpretability. */
  readonly note: string;
}

/** The neutral default — used on the first turn and on any unparseable read. */
export const NEUTRAL_AFFECT: AffectReading = { valence: 0, note: '' };

/** The name of the structured tool the model calls to report its read. */
const REPORT_AFFECT = 'report_affect';

/** The single tool advertised for the read: named fields, no positional guessing. */
const REPORT_AFFECT_TOOL: ToolDef = {
  name: REPORT_AFFECT,
  description: "Report the user's current emotional state, judged from their latest message.",
  parameters: {
    type: 'object',
    properties: {
      valence: {
        type: 'number',
        minimum: -1,
        maximum: 1,
        description:
          'How the user feels right now: 1 = clearly pleased/warm, ' +
          '0 = neutral, -1 = clearly upset/annoyed.',
      },
      note: {
        type: 'string',
        description: 'A few words naming the mood (e.g. "relieved", "frustrated, terse").',
      },
    },
    required: ['valence', 'note'],
    additionalProperties: false,
  },
};

export interface AffectSenseDeps {
  readonly llm: LlmGateway;
  /** Cheap model for the one-shot read (reuse the ingestion model). */
  readonly model: string;
  readonly logger: Logger;
  /** Bills the read to the user's stamina; omit = unmetered (tests). */
  readonly quota?: TokenQuotaStore;
}

export interface AffectSenseParams {
  /** The user whose stamina the read is billed to. */
  readonly ownerId?: string;
  /** A short slice of the recent conversation, for context. */
  readonly recentContext: string;
  /** The user's latest message — the turn being read. */
  readonly userText: string;
}

/**
 * Read the user's affect from their latest message (in recent context). Returns
 * {@link NEUTRAL_AFFECT} on any failure or when the model declines to report —
 * ambiguity must never masquerade as a strong signal. Never throws.
 */
export async function senseAffect(
  deps: AffectSenseDeps,
  params: AffectSenseParams,
): Promise<AffectReading> {
  try {
    const usage = createUsageAccumulator();
    const llm = meteredLlmGateway(deps.llm, usage.sink);
    const system =
      'You read the emotional state of a user talking to their AI companion. ' +
      'Judge how the user feels RIGHT NOW from their latest message in context, ' +
      `then report it by calling the ${REPORT_AFFECT} tool. Always call the tool; ` +
      'do not reply with prose.';
    const user =
      (params.recentContext ? `Recent conversation:\n${params.recentContext}\n\n` : '') +
      `The user just said:\n"${params.userText}"`;

    const result = await drain(
      llm.stream({
        model: deps.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: [REPORT_AFFECT_TOOL],
      }),
    );
    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_AFFECT);
    const reading = call ? coerceReading(call.args) : NEUTRAL_AFFECT;

    // Bill best-effort AFTER the reading is in hand: a quota hiccup is our infra
    // fault and must never void a valid read (which would poison the delta with a
    // fake neutral). Log it and carry on (logging.md, billing-crash policy).
    if (deps.quota && params.ownerId) {
      const total = usage.total().totalTokens;
      if (total > 0) {
        try {
          await deps.quota.recordUsage(params.ownerId, total);
        } catch (error) {
          deps.logger.error('failed to record affect read usage', {
            operation: 'motivation.affect.bill',
            ownerId: params.ownerId,
            error,
          });
        }
      }
    }

    return reading;
  } catch (error) {
    deps.logger.error('failed to sense user affect', {
      operation: 'motivation.affect.sense',
      ownerId: params.ownerId,
      error,
    });
    return NEUTRAL_AFFECT;
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
