/**
 * The equipped-tools legibility arm (companion-tools.md §4) — a `RetrieveContext`
 * arm that tells the model which tools it currently has equipped and callable, so
 * the dynamically-changing tool set stays legible (a tool appearing or falling
 * away under the equipped-tool cap is never silent). Grounding-only: no embeddings, no
 * recency window, zero usage; degrades to no block on failure (recall never breaks
 * the conversation). The equipped tools themselves are advertised via the per-step
 * registry (equipped-resolver.ts); this arm is just the summary line.
 */

import { type CapabilitySource, indexCapabilitySources } from '../acquisition/capability-source.js';
import type { EquippedToolStore } from '../mcp/equipped-store.js';
import type { Logger } from '../logging.js';
import { ZERO_USAGE } from '../usage.js';
import type { RetrieveContext } from './hooks.js';

export interface EquippedSummaryOptions {
  readonly equipped: EquippedToolStore;
  /** Same sources the resolver consults, so we never advertise a revoked tool. */
  readonly sources: readonly CapabilitySource[];
  readonly logger: Logger;
}

/** Build the equipped-tools summary `RetrieveContext` arm (grounding-only). */
export function createEquippedSummaryContext(options: EquippedSummaryOptions): RetrieveContext {
  const sources = indexCapabilitySources(options.sources);
  return async ({ companionId }) => {
    try {
      const equipped = await options.equipped.list(companionId);
      // Drop any record whose source has revoked it — the resolver
      // (equipped-resolver.ts) already skips these, so advertising them here would
      // claim a tool the model cannot actually invoke.
      const callable = equipped.filter((record) =>
        sources.get(record.source)?.isAdmissible(record.serverRef),
      );
      if (callable.length === 0) {
        return { blocks: [], usage: ZERO_USAGE };
      }
      // `record.toolId` is the tool's advertised name (the adapter and the catalog
      // builder derive both from the same rule), so the summary names match the
      // names the registry dispatches on — no recomputation needed.
      const lines = callable
        .map((record) => `- \`${record.toolId}\`: ${record.snapshot.description}`)
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
