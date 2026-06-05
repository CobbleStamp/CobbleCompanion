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
 * Best-effort: a perception hiccup must never disrupt the chat turn (logging.md).
 * The read rides the chat turn, so its tokens bill the user's STAMINA, not energy.
 */

import type { LlmGateway } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { TokenQuotaStore } from '../quota/store.js';
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
 * {@link NEUTRAL_AFFECT} on any failure or unparseable reply — ambiguity must
 * never masquerade as a strong signal. Never throws.
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
      'Judge how the user feels RIGHT NOW from their latest message in context. ' +
      'Reply with EXACTLY two lines and nothing else:\n' +
      'Line 1: a number from -1 to 1 (1 = clearly pleased/warm, 0 = neutral, ' +
      '-1 = clearly upset/annoyed).\n' +
      'Line 2: a few words naming the mood (e.g. "relieved", "frustrated, terse").';
    const user =
      (params.recentContext ? `Recent conversation:\n${params.recentContext}\n\n` : '') +
      `The user just said:\n"${params.userText}"`;

    let text = '';
    for await (const delta of llm.stream({
      model: deps.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })) {
      text += delta;
    }
    if (deps.quota && params.ownerId) {
      const total = usage.total().totalTokens;
      if (total > 0) {
        await deps.quota.recordUsage(params.ownerId, total);
      }
    }
    return parseAffect(text);
  } catch (error) {
    deps.logger.error('failed to sense user affect', {
      operation: 'motivation.affect.sense',
      ownerId: params.ownerId,
      error,
    });
    return NEUTRAL_AFFECT;
  }
}

/**
 * Parse the two-line affect reply: first signed decimal → valence (clamped to
 * [−1, 1]); the first non-numeric line → note. Defaults to {@link NEUTRAL_AFFECT}
 * when nothing usable is found.
 */
export function parseAffect(text: string): AffectReading {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let valence = 0;
  let note = '';
  for (const line of lines) {
    const match = line.match(/-?\d+(\.\d+)?/);
    if (match && valence === 0 && note === '') {
      const value = Number.parseFloat(match[0]);
      if (Number.isFinite(value)) {
        valence = Math.min(1, Math.max(-1, value));
      }
      // If the same line also carries words, keep them as a fallback note
      // (strip the leading separator punctuation between number and words).
      const words = line
        .replace(match[0], '')
        .replace(/^[\s|:.–—-]+/, '')
        .trim();
      if (words.length > 0 && note === '') {
        note = words;
      }
      continue;
    }
    if (note === '') {
      note = line;
    }
  }
  return { valence, note };
}
