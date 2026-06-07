/**
 * The proactive-load advisor (companion-tools.md §5) — the bridge from procedural
 * recall to equipping. Given the tool steps of a routine the companion has
 * recalled, it names the tools worth picking up *before* the job starts: those
 * that exist in the catalog (so they can be loaded) but are not currently
 * equipped. The procedural-memory arm (harness/procedural-retrieve.ts) turns that
 * list into a hint, and the model decides to `load_tool` them — discovery stays
 * explicit and model-driven (§2), this only surfaces the candidates.
 *
 * An MCP tool's advertised name is its catalog id (`mcp__<ref>__<tool>`,
 * adapter.ts) and the same id is what a routine records as a step and what the
 * equipped set keys on — so the match is exact, no fuzzy resolution. Steps that
 * are not catalog ids (the fixed core tools, or free text) simply find no entry
 * and are skipped. Never throws: any failure degrades to "nothing to suggest".
 */

import type { Logger } from '../logging.js';
import type { EquippedToolStore } from './equipped-store.js';
import type { ToolCatalogStore } from './tool-catalog-store.js';

export interface ToolLoadAdvisor {
  /**
   * From a recalled routine's tool steps, the catalog ids worth loading
   * proactively: in the catalog, not already equipped. De-duplicated,
   * first-seen order.
   */
  suggestProactiveLoads(companionId: string, steps: readonly string[]): Promise<readonly string[]>;
}

export interface ToolLoadAdvisorOptions {
  readonly catalog: ToolCatalogStore;
  readonly equipped: EquippedToolStore;
  readonly logger: Logger;
}

export function createToolLoadAdvisor(options: ToolLoadAdvisorOptions): ToolLoadAdvisor {
  return {
    async suggestProactiveLoads(companionId, steps) {
      const unique = [...new Set(steps)];
      if (unique.length === 0) {
        return [];
      }
      try {
        const equipped = new Set(
          (await options.equipped.list(companionId)).map((record) => record.toolId),
        );
        const suggestions: string[] = [];
        for (const step of unique) {
          if (equipped.has(step)) {
            continue; // already in hand
          }
          const entry = await options.catalog.get(step);
          if (entry) {
            suggestions.push(entry.toolId);
          }
        }
        return suggestions;
      } catch (error) {
        options.logger.error('proactive-load suggestion failed; suggesting none', {
          operation: 'mcp.loadAdvisor.suggest',
          companionId,
          error,
        });
        return [];
      }
    },
  };
}
