/**
 * The per-companion tool-registry resolver (companion-tools.md §4) — composes the
 * fixed core tools (native tools + search_tools/load_tool) with the companion's
 * **equipped** tools into one {@link ToolRegistry}, behind the same interface the
 * harness consumes. The harness calls this **per model step**, so a tool loaded
 * mid-turn appears on the next step. Each equipped tool's snapshot is adapted on
 * the fly; a server that has since dropped off the whitelist contributes nothing
 * (de-whitelisting revokes its tools immediately, even mid-conversation). A
 * successful or failed call bumps the tool's recency so the LRU keeps the tools
 * actually in use (equipped-store.ts).
 */

import { consoleLogger, type Logger } from '../logging.js';
import { type Tool } from '../tools/tool.js';
import { ToolRegistry } from '../tools/registry.js';
import { mcpToolToTool } from './adapter.js';
import type { EquippedToolStore } from './equipped-store.js';
import type { McpGateway, McpServerSpec } from './gateway.js';
import type { McpWhitelist, McpWhitelistEntry } from './whitelist.js';

export interface EquippedRegistryResolverOptions {
  /** The always-present core tools: native tools + search_tools + load_tool. */
  readonly nativeTools: readonly Tool[];
  readonly equipped: EquippedToolStore;
  readonly whitelist: McpWhitelist;
  readonly gateway: McpGateway;
  /** Resolve a server's request headers (e.g. its auth-token env) at call time. */
  readonly authHeaders?: (entry: McpWhitelistEntry) => Readonly<Record<string, string>> | undefined;
  readonly logger?: Logger;
}

/**
 * Build a `resolveRegistry(companionId)` for the harness: core tools + the companion's
 * equipped (and still-whitelisted) MCP tools. The harness degrades to its static
 * registry if this throws, so a store hiccup never breaks a turn.
 */
export function createEquippedRegistryResolver(
  options: EquippedRegistryResolverOptions,
): (companionId: string) => Promise<ToolRegistry> {
  const logger = options.logger ?? consoleLogger;
  return async (companionId) => {
    const equipped = await options.equipped.list(companionId);
    const mcpTools: Tool[] = [];
    for (const record of equipped) {
      const server = options.whitelist.get(record.serverRef);
      if (!server) {
        // De-whitelisted since it was equipped → drop its tool.
        continue;
      }
      const headers = options.authHeaders?.(server);
      const spec: McpServerSpec = {
        ref: server.ref,
        endpoint: server.endpoint,
        ...(headers ? { headers } : {}),
      };
      const base = mcpToolToTool({
        gateway: options.gateway,
        spec,
        mcpTool: record.snapshot,
        logger,
      });
      mcpTools.push(withUsageTracking(base, options.equipped, companionId, record.toolId, logger));
    }
    return new ToolRegistry([...options.nativeTools, ...mcpTools], logger);
  };
}

/** Wrap a tool so a call bumps its recency (keeps the LRU honest). */
function withUsageTracking(
  base: Tool,
  equipped: EquippedToolStore,
  companionId: string,
  toolId: string,
  logger: Logger,
): Tool {
  return {
    ...base,
    async run(args, ctx) {
      const result = await base.run(args, ctx);
      // The tool was used regardless of outcome — record recency/frequency.
      await equipped.touch(companionId, toolId).catch((error: unknown) =>
        logger.error('failed to record equipped-tool usage', {
          operation: 'mcp.equippedResolver.touch',
          companionId,
          toolId,
          error,
        }),
      );
      return result;
    },
  };
}
