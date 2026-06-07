/**
 * Build the tool catalog from the whitelist (companion-tools.md §5). For each
 * whitelisted MCP server, fetch its `tools/list` and upsert one **lightweight**
 * catalog entry per tool (id + name + description — no argument schema), then
 * prune entries for tools/servers no longer whitelisted. Runs at startup and on
 * a whitelist change. A server that's unreachable keeps its existing entries
 * (stale beats gone) and is logged — building the catalog never hard-fails.
 */

import { consoleLogger, type Logger } from '../logging.js';
import { mcpToolName } from './adapter.js';
import type { McpGateway, McpServerSpec } from './gateway.js';
import type { ToolCatalogStore, ToolCatalogEntry } from './tool-catalog-store.js';
import type { McpWhitelist, McpWhitelistEntry } from './whitelist.js';

export interface RefreshCatalogOptions {
  readonly whitelist: McpWhitelist;
  readonly gateway: McpGateway;
  readonly catalog: ToolCatalogStore;
  /** Resolve a server's request headers (e.g. its auth-token env) for the list call. */
  readonly authHeaders?: (entry: McpWhitelistEntry) => Readonly<Record<string, string>> | undefined;
  readonly logger?: Logger;
}

/**
 * Refresh the catalog to mirror the current whitelist. Returns the number of tools
 * indexed. Best-effort per server: a failed `tools/list` keeps that server's prior
 * entries rather than dropping them, so a transient outage can't empty the catalog.
 */
export async function refreshToolCatalog(options: RefreshCatalogOptions): Promise<number> {
  const logger = options.logger ?? consoleLogger;
  const indexed: ToolCatalogEntry[] = [];
  const reachedServerRefs = new Set<string>();

  for (const entry of options.whitelist.list()) {
    const headers = options.authHeaders?.(entry);
    const spec: McpServerSpec = {
      ref: entry.ref,
      endpoint: entry.endpoint,
      ...(headers ? { headers } : {}),
    };
    try {
      const tools = await options.gateway.listTools(spec);
      reachedServerRefs.add(entry.ref);
      for (const tool of tools) {
        indexed.push({
          toolId: mcpToolName(entry.ref, tool.name),
          source: 'mcp',
          serverRef: entry.ref,
          toolName: tool.name,
          description: tool.description,
        });
      }
    } catch (error) {
      // Stale beats gone: skip this server so its existing rows survive the prune.
      logger.error(
        'catalog refresh: could not list a whitelisted MCP server; keeping stale entries',
        {
          operation: 'mcp.refreshCatalog',
          server: entry.ref,
          error,
        },
      );
    }
  }

  await options.catalog.upsert(indexed);
  await pruneStale(options.catalog, options.whitelist, reachedServerRefs, indexed, logger);
  return indexed.length;
}

/**
 * Drop catalog rows that are no longer valid: tools whose server fell off the
 * whitelist, and tools that a *reached* server stopped advertising. Entries for a
 * server we could not reach this pass are preserved (we can't tell removed from
 * unreachable), so an outage never prunes a still-whitelisted server.
 */
async function pruneStale(
  catalog: ToolCatalogStore,
  whitelist: McpWhitelist,
  reachedServerRefs: ReadonlySet<string>,
  indexed: readonly ToolCatalogEntry[],
  logger: Logger,
): Promise<void> {
  const existing = await catalog.list();
  const freshIds = new Set(indexed.map((entry) => entry.toolId));
  const keep: string[] = [];
  for (const entry of existing) {
    const stillWhitelisted = whitelist.isAllowed(entry.serverRef);
    const serverReached = reachedServerRefs.has(entry.serverRef);
    // Keep if it was just (re)indexed, or it belongs to a still-whitelisted
    // server we couldn't reach this pass (preserve its stale entries).
    if (freshIds.has(entry.toolId) || (stillWhitelisted && !serverReached)) {
      keep.push(entry.toolId);
    }
  }
  await catalog.deleteNotIn(keep);
  const pruned = existing.length - keep.length;
  if (pruned > 0) {
    logger.info('catalog refresh: pruned stale tool entries', {
      operation: 'mcp.refreshCatalog',
      pruned,
    });
  }
}
