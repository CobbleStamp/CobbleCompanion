/**
 * Assemble the MCP tool-acquisition wiring (companion-tools.md §3–§5) shared by
 * the production graph (index.ts) and the test app (test/helpers.ts): the
 * whitelist, the deployment tool catalog, the per-companion equipped set, the
 * `search_tools` + `load_tool` core tools, the per-step registry resolver, and the
 * equipped-tools legibility arm. Returns null when no servers are whitelisted, so
 * acquisition stays entirely off (behaviour unchanged) unless an operator
 * configures `MCP_SERVERS`. `refreshCatalog()` (re)builds the catalog from the
 * whitelist; the caller runs it at startup and on whitelist changes.
 */

import {
  type CapabilitySource,
  consoleLogger,
  createEquippedRegistryResolver,
  createEquippedSummaryContext,
  createLoadToolTool,
  createMcpCapabilitySource,
  createSearchToolsTool,
  createToolLoadAdvisor,
  DrizzleEquippedToolStore,
  DrizzleToolCatalogStore,
  type ToolLoadAdvisor,
  type LlmGateway,
  type Logger,
  type McpGateway,
  type McpWhitelistEntry,
  McpWhitelist,
  refreshToolCatalog,
  type RetrieveContext,
  type TokenQuotaStore,
  type Tool,
  type ToolRegistry,
} from '@cobble/core';
import type { Database } from '@cobble/db';
import type { AppConfig } from '../config.js';

export interface McpWiring {
  /** The core tools advertised every step: native tools + search_tools + load_tool. */
  readonly nativeTools: readonly Tool[];
  /** Per-step registry resolver: core tools + the companion's equipped MCP tools. */
  readonly resolveRegistry: (companionId: string) => Promise<ToolRegistry>;
  /** The RetrieveContext arm that lists the companion's currently-equipped tools. */
  readonly equippedArm: RetrieveContext;
  /** Bridges procedural recall → proactive loading: which routine tools to pick up. */
  readonly loadAdvisor: ToolLoadAdvisor;
  /** (Re)build the catalog from the whitelist; returns the number of tools indexed. */
  readonly refreshCatalog: () => Promise<number>;
}

export interface BuildMcpWiringOptions {
  readonly config: AppConfig;
  readonly db: Database;
  /** Speaks the MCP wire protocol (list/call) to whitelisted servers. */
  readonly gateway: McpGateway;
  /** The LLM gateway for the off-loop `search_tools` lookup. */
  readonly llmGateway: LlmGateway;
  /** The existing native tools (web_fetch, memory_search, ingest_source). */
  readonly baseTools: readonly Tool[];
  /** Bills the `search_tools` lookup to the owner's stamina; omit = unmetered. */
  readonly quota?: TokenQuotaStore;
  readonly logger?: Logger;
}

/** Resolve a server's bearer-token from its whitelisted env-var name (server host). */
export function envAuthHeaders(
  entry: McpWhitelistEntry,
): Readonly<Record<string, string>> | undefined {
  if (!entry.authTokenEnv) {
    return undefined;
  }
  const token = process.env[entry.authTokenEnv];
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** Build the MCP wiring, or null when no servers are whitelisted (feature off). */
export function buildMcpWiring(options: BuildMcpWiringOptions): McpWiring | null {
  const { config, db, gateway, llmGateway } = options;
  if (config.mcpServers.length === 0) {
    return null;
  }
  const logger = options.logger ?? consoleLogger;
  const whitelist = new McpWhitelist(config.mcpServers);
  const catalog = new DrizzleToolCatalogStore(db);
  const equipped = new DrizzleEquippedToolStore(db);

  // The MCP server source; future sources (CLI, Phase 10) compose into this array.
  const mcpSource = createMcpCapabilitySource({
    whitelist,
    gateway,
    authHeaders: envAuthHeaders,
    logger,
  });
  const sources: readonly CapabilitySource[] = [mcpSource];

  const searchTool = createSearchToolsTool({
    catalog,
    gateway: llmGateway,
    model: config.ingestionModel,
    ...(options.quota ? { quota: options.quota } : {}),
    logger,
  });
  const loadTool = createLoadToolTool({
    catalog,
    equipped,
    sources,
    maxEquippedTools: config.maxEquippedTools,
    logger,
  });
  const nativeTools: readonly Tool[] = [...options.baseTools, searchTool, loadTool];

  const resolveRegistry = createEquippedRegistryResolver({
    nativeTools,
    equipped,
    sources,
    logger,
  });
  const equippedArm = createEquippedSummaryContext({ equipped, sources, logger });
  const loadAdvisor = createToolLoadAdvisor({ catalog, equipped, logger });

  return {
    nativeTools,
    resolveRegistry,
    equippedArm,
    loadAdvisor,
    refreshCatalog: () => refreshToolCatalog({ sources, catalog, logger }),
  };
}
