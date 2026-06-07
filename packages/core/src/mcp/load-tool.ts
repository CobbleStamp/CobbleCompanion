/**
 * The `load_tool` core tool (companion-tools.md §4/§5) — pick a tool the catalog
 * surfaced and make it callable. Source-agnostic: it looks the entry up in the
 * catalog, finds the {@link CapabilitySource} it belongs to, re-checks
 * admissibility (the catalog can never widen the gate, §6), resolves the tool's
 * **fresh** schema through that source (never trusting the catalog stub), and adds
 * it to the companion's equipped set, then enforces the equipped-tool cap by
 * evicting the least-recently-used equipped tool. The loaded tool is advertised on
 * the **next** loop iteration (the per-step registry). Off-catalog ids are denied.
 * `effectful: false` — loading takes no outward action. Never throws: failures
 * become results.
 */

import type { CapabilitySource } from '../acquisition/capability-source.js';
import { indexCapabilitySources } from '../acquisition/capability-source.js';
import type { ToolResult } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import { readStringArg, type Tool, toolErrorMessage } from '../tools/tool.js';
import type { EquippedToolStore } from './equipped-store.js';
import type { ToolCatalogStore } from './tool-catalog-store.js';

export interface LoadToolOptions {
  readonly catalog: ToolCatalogStore;
  readonly equipped: EquippedToolStore;
  /** The capability sources tools can be loaded from (MCP, CLI, …). */
  readonly sources: readonly CapabilitySource[];
  /** Max tools a companion may carry equipped at once; the LRU evicts beyond it. */
  readonly maxEquippedTools: number;
  readonly logger?: Logger;
}

export function createLoadToolTool(options: LoadToolOptions): Tool {
  const logger = options.logger ?? consoleLogger;
  const sources = indexCapabilitySources(options.sources);
  return {
    name: 'load_tool',
    description:
      'Load a tool by its id (from search_tools) so you can call it. The tool becomes ' +
      'available on your next step. Only ids from the catalog can be loaded.',
    parameters: {
      type: 'object',
      properties: {
        tool_id: {
          type: 'string',
          description: 'The id of the tool to load, as returned by search_tools.',
        },
      },
      required: ['tool_id'],
      additionalProperties: false,
    },
    effectful: false,
    stepSummary(args): string {
      return `Loaded tool ${readStringArg(args, 'tool_id') ?? 'a tool'}`;
    },
    async run(rawArgs, ctx): Promise<ToolResult> {
      const toolId = readStringArg(rawArgs, 'tool_id');
      if (toolId === null) {
        return { name: 'load_tool', content: 'Error: load_tool needs a "tool_id".', isError: true };
      }
      try {
        const entry = await options.catalog.get(toolId);
        if (!entry) {
          return {
            name: 'load_tool',
            content: `Error: "${toolId}" is not in the tool catalog. Use search_tools first.`,
            isError: true,
          };
        }
        // The catalog should only hold admissible tools, but the source's live
        // trust check is the gate — re-check it so a stale catalog row can never
        // load a revoked tool (a de-whitelisted server, a removed CLI tool) (§6).
        const source = sources.get(entry.source);
        if (!source || !source.isAdmissible(entry.serverRef)) {
          return {
            name: 'load_tool',
            content: `Error: "${toolId}" is no longer available.`,
            isError: true,
          };
        }
        // Resolve the AUTHORITATIVE schema now — never trust the catalog stub.
        const snapshot = await source.resolveSnapshot(entry);
        if (!snapshot) {
          return {
            name: 'load_tool',
            content: `Error: "${toolId}" is no longer offered by its source.`,
            isError: true,
          };
        }
        await options.equipped.equip(ctx.companionId, {
          toolId: entry.toolId,
          source: entry.source,
          serverRef: entry.serverRef,
          snapshot,
        });
        const evicted = await options.equipped.evictToMaxEquipped(
          ctx.companionId,
          options.maxEquippedTools,
        );
        const note =
          evicted > 0 ? ` (unloaded ${evicted} unused tool${evicted === 1 ? '' : 's'})` : '';
        return {
          name: 'load_tool',
          content: `Loaded "${toolId}". It's available on your next step${note}.`,
        };
      } catch (error) {
        logger.error('load_tool failed', {
          operation: 'acquisition.loadTool',
          companionId: ctx.companionId,
          toolId,
          error,
        });
        return {
          name: 'load_tool',
          content: `Error loading "${toolId}": ${toolErrorMessage(error)}`,
          isError: true,
        };
      }
    },
  };
}
