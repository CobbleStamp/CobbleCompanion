/**
 * Procedural retrieval-as-hint (Phase 5) — fills another arm of the memory hook
 * (invariant #3, no loop change) so a learned, reusable workflow RESURFACES when
 * it's relevant, instead of only being browsable. This is what makes the
 * capabilities checklist functional rather than cosmetic: the companion is
 * reminded "you've done this before, like so" and can reuse the routine.
 *
 * Matching is deliberately cheap for the PoC — lexical word overlap between the
 * user's message and a procedure's title (no embeddings; procedures are short and
 * few). Procedures come from the companion's OWN recorded actions, not untrusted
 * external content, so the hint is rendered plainly (no source-fencing).
 *
 * **Proactive loading (companion-tools.md §5).** When a tool-load advisor is wired
 * (i.e. runtime tool acquisition is on), the recalled routine drives *promotion*:
 * the advisor names the routine's tools that exist in the catalog but aren't
 * equipped, and this arm nudges the companion to `load_tool` them up front — so it
 * picks up what the job needs *before* hitting a wall, rather than only
 * reactively. Loading stays an explicit, model-driven act (§2); this only surfaces
 * the candidates.
 */

import type { Logger } from '../logging.js';
import type { ToolLoadAdvisor } from '../mcp/load-advisor.js';
import type { ProceduralStore } from '../tools/procedural-store.js';
import { ZERO_USAGE } from '../usage.js';
import type { ContextBlock, RetrieveContext } from './hooks.js';

export interface ProceduralRetrieveOptions {
  readonly procedural: ProceduralStore;
  /** How many procedures to scan for a match. */
  readonly scanLimit?: number;
  /** How many matching procedures to surface as hints. */
  readonly topK?: number;
  /**
   * When present (runtime tool acquisition on), turns a recalled routine into a
   * proactive-load nudge for the tools it needs but the companion lacks.
   */
  readonly loadAdvisor?: ToolLoadAdvisor;
  readonly logger: Logger;
}

const DEFAULT_SCAN_LIMIT = 20;
const DEFAULT_TOP_K = 2;

/** Tokenize to lowercase word stems (length ≥ 3) for cheap overlap scoring. */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length >= 3),
  );
}

/** Build the procedural-memory RetrieveContext arm (grounding-only; appends no recency). */
export function createProceduralRetrieveContext(
  options: ProceduralRetrieveOptions,
): RetrieveContext {
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const topK = options.topK ?? DEFAULT_TOP_K;

  return async ({ companionId, userContent }) => {
    try {
      const procedures = await options.procedural.list(companionId, scanLimit);
      if (procedures.length === 0) {
        return { blocks: [], usage: ZERO_USAGE };
      }
      const queryWords = keywords(userContent);
      const scored = procedures
        .map((procedure) => {
          const titleWords = keywords(procedure.title);
          let overlap = 0;
          for (const word of titleWords) {
            if (queryWords.has(word)) {
              overlap += 1;
            }
          }
          return { procedure, overlap };
        })
        .filter((entry) => entry.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, topK);

      const blocks = scored.map((entry) => toHintBlock(entry.procedure));

      // Proactive loading: surface the recalled routines' tools that aren't in hand.
      if (options.loadAdvisor && scored.length > 0) {
        const steps = scored.flatMap((entry) => entry.procedure.steps);
        const toLoad = await options.loadAdvisor.suggestProactiveLoads(companionId, steps);
        const loadBlock = toLoadBlock(toLoad);
        if (loadBlock) {
          blocks.push(loadBlock);
        }
      }

      return { blocks, usage: ZERO_USAGE };
    } catch (error) {
      // Recall never breaks the conversation — degrade this arm to no hints.
      options.logger.error('procedural recall failed; degrading to no hints', {
        operation: 'harness.proceduralRetrieve',
        companionId,
        error,
      });
      return { blocks: [], usage: ZERO_USAGE };
    }
  };
}

/** Render one learned procedure as a system hint the model can choose to reuse. */
function toHintBlock(procedure: { title: string; steps: readonly string[] }): ContextBlock {
  const steps = procedure.steps.length > 0 ? ` (${procedure.steps.join(' → ')})` : '';
  return {
    role: 'system',
    content:
      `You've done this before — a learned routine that may help here: ` +
      `"${procedure.title}"${steps}. Reuse it if it fits.`,
  };
}

/** Nudge the companion to equip the recalled routine's missing tools up front. */
function toLoadBlock(toolIds: readonly string[]): ContextBlock | null {
  if (toolIds.length === 0) {
    return null;
  }
  const ids = toolIds.map((id) => `\`${id}\``).join(', ');
  return {
    role: 'system',
    content:
      `That routine uses tools you don't have equipped yet: ${ids}. ` +
      `Load them now with load_tool so they're ready before you need them.`,
  };
}
