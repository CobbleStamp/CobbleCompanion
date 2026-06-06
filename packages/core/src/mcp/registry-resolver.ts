/**
 * The per-companion tool-registry resolver (companion-tools.md §4) — composes the
 * fixed native tools with a companion's connected-MCP tools into one
 * {@link ToolRegistry}, behind the same interface the harness already consumes (no
 * loop change, invariant #3). Wired into the harness via `resolveRegistry`
 * (harness.ts). Each connected server's snapshot tools are adapted on the fly; a
 * server that has since dropped off the whitelist contributes nothing (so
 * de-whitelisting a server immediately revokes its tools, even mid-conversation).
 */

import { consoleLogger, type Logger } from '../logging.js';
import { type Tool } from '../tools/tool.js';
import { ToolRegistry } from '../tools/registry.js';
import { mcpToolToTool } from './adapter.js';
import type { McpConnectionStore } from './connection-store.js';
import type { McpGateway, McpServerSpec } from './gateway.js';
import type { McpWhitelist, McpWhitelistEntry } from './whitelist.js';

export interface McpRegistryResolverOptions {
  /** The always-present native tools (web_fetch, memory_search, …, connect_mcp). */
  readonly nativeTools: readonly Tool[];
  readonly whitelist: McpWhitelist;
  readonly connections: McpConnectionStore;
  readonly gateway: McpGateway;
  /** Resolve a server's request headers (e.g. its auth-token env) at call time. */
  readonly authHeaders?: (entry: McpWhitelistEntry) => Readonly<Record<string, string>> | undefined;
  readonly logger?: Logger;
}

/**
 * Build a `resolveRegistry(companionId)` function for the harness: native tools +
 * the companion's connected (and still-whitelisted) MCP tools. The harness already
 * degrades to its static registry if this throws, so a store hiccup never breaks a
 * turn — but listing is best-effort here too.
 */
export function createMcpRegistryResolver(
  options: McpRegistryResolverOptions,
): (companionId: string) => Promise<ToolRegistry> {
  const logger = options.logger ?? consoleLogger;
  return async (companionId) => {
    const connections = await options.connections.list(companionId);
    const mcpTools: Tool[] = [];
    for (const connection of connections) {
      if (connection.status !== 'connected') {
        continue;
      }
      const entry = options.whitelist.get(connection.serverRef);
      if (!entry) {
        // De-whitelisted since the companion connected → drop its tools.
        continue;
      }
      const headers = options.authHeaders?.(entry);
      const spec: McpServerSpec = {
        ref: entry.ref,
        endpoint: entry.endpoint,
        ...(headers ? { headers } : {}),
      };
      for (const mcpTool of connection.toolsSnapshot) {
        mcpTools.push(mcpToolToTool({ gateway: options.gateway, spec, mcpTool, logger }));
      }
    }
    return new ToolRegistry([...options.nativeTools, ...mcpTools], logger);
  };
}
