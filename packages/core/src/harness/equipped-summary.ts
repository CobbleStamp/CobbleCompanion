/**
 * The equipped-tools legibility arm (companion-tools.md §4) — a `RetrieveContext`
 * arm that tells the model which tools it currently has equipped and callable, so
 * the dynamically-changing tool set stays legible (a tool appearing or falling
 * away under the equipped-tool cap is never silent). Grounding-only: no embeddings, no
 * recency window, zero usage; degrades to no block on failure (recall never breaks
 * the conversation). The equipped tools themselves are advertised via the per-step
 * registry (equipped-resolver.ts); this arm is just the summary line.
 */

import { mcpToolName } from '../mcp/adapter.js';
import type { EquippedToolStore } from '../mcp/equipped-store.js';
import type { Logger } from '../logging.js';
import { ZERO_USAGE } from '../usage.js';
import type { RetrieveContext } from './hooks.js';

export interface EquippedSummaryOptions {
  readonly equipped: EquippedToolStore;
  readonly logger: Logger;
}

/** Build the equipped-tools summary `RetrieveContext` arm (grounding-only). */
export function createEquippedSummaryContext(options: EquippedSummaryOptions): RetrieveContext {
  return async ({ companionId }) => {
    try {
      const equipped = await options.equipped.list(companionId);
      if (equipped.length === 0) {
        return { blocks: [], usage: ZERO_USAGE };
      }
      const lines = equipped
        .map((record) => {
          const name = mcpToolName(record.serverRef, record.snapshot.name);
          return `- \`${name}\`: ${record.snapshot.description}`;
        })
        .join('\n');
      return {
        blocks: [
          {
            role: 'system',
            content:
              `You currently have these tools equipped and callable:\n${lines}\n` +
              'Use search_tools / load_tool to acquire others when a job needs one.',
          },
        ],
        usage: ZERO_USAGE,
      };
    } catch (error) {
      options.logger.error('equipped-tools summary failed; degrading to no block', {
        operation: 'harness.equippedSummary',
        companionId,
        error,
      });
      return { blocks: [], usage: ZERO_USAGE };
    }
  };
}
