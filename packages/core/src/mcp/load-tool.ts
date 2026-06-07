/**
 * The `load_tool` core tool (companion-tools.md §4/§5) — pick a tool the catalog
 * surfaced and make it callable. It re-checks the whitelist (the catalog can never
 * widen the gate, §6), fetches the tool's **fresh** schema (never trusting the
 * catalog stub), and adds it to the companion's equipped set, then enforces the
 * equipped-tool cap by evicting the least-recently-used equipped tool. The loaded tool
 * is advertised on the **next** loop iteration (the per-step registry). Off-catalog
 * ids are denied. `effectful: false` — loading takes no outward action. Never
 * throws: failures become results.
 */

import type { ToolResult } from '../harness/hooks.js';
import { assertPublicHttpUrl } from '../ingestion/url-guard.js';
import { consoleLogger, type Logger } from '../logging.js';
import { readStringArg, type Tool, toolErrorMessage } from '../tools/tool.js';
import type { McpGateway, McpServerSpec } from './gateway.js';
import type { EquippedToolStore } from './equipped-store.js';
import type { ToolCatalogStore } from './tool-catalog-store.js';
import type { McpWhitelist, McpWhitelistEntry } from './whitelist.js';

export interface LoadToolOptions {
  readonly catalog: ToolCatalogStore;
  readonly equipped: EquippedToolStore;
  readonly gateway: McpGateway;
  readonly whitelist: McpWhitelist;
  /** Resolve a server's request headers (e.g. its auth-token env) at load time. */
  readonly authHeaders?: (entry: McpWhitelistEntry) => Readonly<Record<string, string>> | undefined;
  /** Max tools a companion may carry equipped at once; the LRU evicts beyond it. */
  readonly maxEquippedTools: number;
  readonly logger?: Logger;
}

export function createLoadToolTool(options: LoadToolOptions): Tool {
  const logger = options.logger ?? consoleLogger;
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
        // The catalog should only hold whitelisted tools, but the whitelist is the
        // gate — re-check it so a stale catalog row can never load a de-whitelisted
        // server's tool (§6).
        const server = options.whitelist.get(entry.serverRef);
        if (!server) {
          return {
            name: 'load_tool',
            content: `Error: "${toolId}" is no longer available.`,
            isError: true,
          };
        }
        // Defense-in-depth string check before the network call; the gateway's
        // transport re-validates DNS (SSRF guard, §7).
        assertPublicHttpUrl(server.endpoint);
        const headers = options.authHeaders?.(server);
        const spec: McpServerSpec = {
          ref: server.ref,
          endpoint: server.endpoint,
          ...(headers ? { headers } : {}),
        };
        // Fetch the AUTHORITATIVE schema now — never trust the catalog stub.
        const tools = await options.gateway.listTools(spec);
        const fresh = tools.find((tool) => tool.name === entry.toolName);
        if (!fresh) {
          return {
            name: 'load_tool',
            content: `Error: "${entry.toolName}" is no longer offered by the "${server.ref}" server.`,
            isError: true,
          };
        }
        await options.equipped.equip(ctx.companionId, {
          toolId: entry.toolId,
          source: entry.source,
          serverRef: entry.serverRef,
          snapshot: {
            name: fresh.name,
            description: fresh.description,
            inputSchema: fresh.inputSchema,
          },
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
          operation: 'mcp.loadTool',
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
