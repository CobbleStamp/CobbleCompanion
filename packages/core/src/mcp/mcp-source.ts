/**
 * The MCP {@link CapabilitySource} (companion-tools.md §3) — wraps the MCP
 * whitelist + gateway + adapter so MCP servers plug into the shared
 * discover → load → call → remember spine as one source among others. All the
 * MCP-specific behaviour that the generic seams (catalog-builder, load-tool,
 * equipped-resolver) used to hard-code lives here:
 *
 *  - `listCatalog`  — `tools/list` each whitelisted server, index its tools as
 *    lightweight catalog entries; a server that fails to list keeps its stale
 *    entries (its ref is returned in `retainStaleRefs`), so an outage never
 *    empties the catalog.
 *  - `isAdmissible` — the whitelist lookup (the binary trust gate, §6).
 *  - `resolveSnapshot` — fetch the **fresh** schema at load time (defended by the
 *    SSRF string guard before the call; the transport re-validates DNS, §7).
 *  - `adapt` — `mcpToolToTool`, proxying the call over the gateway.
 */

import type { McpToolSnapshot, ToolCatalogEntry } from '@cobble/shared';

import type { CapabilitySource, CatalogContribution } from '../acquisition/capability-source.js';
import { assertPublicHttpUrl } from '../ingestion/url-guard.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { Tool } from '../tools/tool.js';
import { mcpToolName, mcpToolToTool } from './adapter.js';
import type { EquippedToolRecord } from './equipped-store.js';
import type { McpGateway, McpServerSpec } from './gateway.js';
import type { McpWhitelist, McpWhitelistEntry } from './whitelist.js';

export interface McpCapabilitySourceOptions {
  readonly whitelist: McpWhitelist;
  readonly gateway: McpGateway;
  /** Resolve a server's request headers (e.g. its auth-token env) at call time. */
  readonly authHeaders?: (entry: McpWhitelistEntry) => Readonly<Record<string, string>> | undefined;
  readonly logger?: Logger;
}

/** Build the MCP capability source from a whitelist + gateway. */
export function createMcpCapabilitySource(options: McpCapabilitySourceOptions): CapabilitySource {
  const logger = options.logger ?? consoleLogger;
  const { whitelist, gateway } = options;

  const specFor = (entry: McpWhitelistEntry): McpServerSpec => {
    const headers = options.authHeaders?.(entry);
    return { ref: entry.ref, endpoint: entry.endpoint, ...(headers ? { headers } : {}) };
  };

  return {
    source: 'mcp',

    async listCatalog(): Promise<CatalogContribution> {
      const entries: ToolCatalogEntry[] = [];
      const retainStaleRefs = new Set<string>();
      for (const entry of whitelist.list()) {
        try {
          const tools = await gateway.listTools(specFor(entry));
          for (const tool of tools) {
            entries.push({
              toolId: mcpToolName(entry.ref, tool.name),
              source: 'mcp',
              serverRef: entry.ref,
              toolName: tool.name,
              description: tool.description,
            });
          }
        } catch (error) {
          // Stale beats gone: keep this server's existing rows through the prune.
          retainStaleRefs.add(entry.ref);
          logger.error(
            'catalog refresh: could not list a whitelisted MCP server; keeping stale entries',
            { operation: 'mcp.listCatalog', server: entry.ref, error },
          );
        }
      }
      return { entries, retainStaleRefs };
    },

    isAdmissible(serverRef: string): boolean {
      return whitelist.isAllowed(serverRef);
    },

    async resolveSnapshot(entry: ToolCatalogEntry): Promise<McpToolSnapshot | null> {
      const server = whitelist.get(entry.serverRef);
      if (!server) {
        return null;
      }
      // Defense-in-depth string check before the network call; the gateway's
      // transport re-validates DNS (SSRF guard, §7).
      assertPublicHttpUrl(server.endpoint);
      const tools = await gateway.listTools(specFor(server));
      const fresh = tools.find((tool) => tool.name === entry.toolName);
      if (!fresh) {
        return null;
      }
      return { name: fresh.name, description: fresh.description, inputSchema: fresh.inputSchema };
    },

    adapt(record: EquippedToolRecord): Tool | null {
      const server = whitelist.get(record.serverRef);
      if (!server) {
        // De-whitelisted since it was equipped → drop its tool.
        return null;
      }
      return mcpToolToTool({
        gateway,
        spec: specFor(server),
        mcpTool: record.snapshot,
        logger,
      });
    },
  };
}
