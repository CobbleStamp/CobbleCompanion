/**
 * Compose several RetrieveContext arms into the single hook the harness expects
 * (the hook is one slot — invariant #3). Each arm runs for the turn; their
 * blocks are concatenated in the given order and their token usage summed, so
 * the harness meters the whole turn. Arms run sequentially to keep ordering
 * simple.
 *
 * Error isolation is enforced HERE, not left to each arm's own discipline: a
 * throwing arm is caught, logged, and degraded to an empty result, so one arm
 * failing never blocks the others and never breaks the turn ("recall never
 * breaks the conversation"). Arms still degrade internally too — this is the
 * structural backstop for anything they don't anticipate.
 *
 * Ordering matters: pass the grounding-only arms first (episodic, semantic) and
 * the arm that appends the recency transcript window LAST, so recency stays at
 * the end of the assembled context and is never duplicated.
 */

import type { Logger } from '../logging.js';
import { addUsage, ZERO_USAGE } from '../usage.js';
import type { ContextBlock, RetrieveContext } from './hooks.js';

/**
 * Run each arm for the turn; concatenate blocks (in order) and sum usage. A arm
 * that throws is logged and contributes nothing, leaving the rest intact.
 */
export function composeRetrieveContext(
  logger: Logger,
  ...arms: readonly RetrieveContext[]
): RetrieveContext {
  return async (params) => {
    const blocks: ContextBlock[] = [];
    let usage = ZERO_USAGE;
    for (const arm of arms) {
      try {
        const result = await arm(params);
        blocks.push(...result.blocks);
        usage = addUsage(usage, result.usage);
      } catch (error) {
        // Degrade this arm to empty; the turn proceeds on whatever the others
        // (and the recency window) provide. Failures are data (logging.md).
        logger.error('a retrieve-context arm threw; degrading it to no blocks', {
          operation: 'harness.composeRetrieveContext',
          companionId: params.companionId,
          error,
        });
      }
    }
    return { blocks, usage };
  };
}
