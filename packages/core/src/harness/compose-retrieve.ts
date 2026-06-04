/**
 * Compose several RetrieveContext arms into the single hook the harness expects
 * (the hook is one slot — invariant #3). Each arm runs for the turn; their
 * blocks are concatenated in the given order and their token usage summed, so
 * the harness meters the whole turn. Arms run sequentially to keep ordering and
 * error handling simple — each arm already degrades internally, so one arm's
 * empty result never blocks the others.
 *
 * Ordering matters: pass the grounding-only arms first (episodic, semantic) and
 * the arm that appends the recency transcript window LAST, so recency stays at
 * the end of the assembled context and is never duplicated.
 */

import { addUsage, ZERO_USAGE } from '../usage.js';
import type { ContextBlock, RetrieveContext } from './hooks.js';

/** Run each arm for the turn; concatenate blocks (in order) and sum usage. */
export function composeRetrieveContext(...arms: readonly RetrieveContext[]): RetrieveContext {
  return async (params) => {
    const blocks: ContextBlock[] = [];
    let usage = ZERO_USAGE;
    for (const arm of arms) {
      const result = await arm(params);
      blocks.push(...result.blocks);
      usage = addUsage(usage, result.usage);
    }
    return { blocks, usage };
  };
}
