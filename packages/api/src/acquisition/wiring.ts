/**
 * Assemble the tool-acquisition wiring (companion-tools.md §3–§5) shared by the
 * production graph (index.ts) and the test app (test/helpers.ts): the capability
 * sources (MCP servers and/or host CLIs), the deployment tool catalog, the
 * per-companion equipped set, the `search_tools` + `load_tool` core tools, the
 * per-step registry resolver, and the equipped-tools legibility arm. Returns null
 * when **no** source is configured, so acquisition stays entirely off (behaviour
 * unchanged) unless an operator sets `MCP_SERVERS` and/or `CLI_TOOLS_PATH`.
 * `refreshCatalog()` (re)builds the catalog from all configured sources; the caller
 * runs it at startup and on a whitelist/definition change.
 */

import {
  type CapabilitySource,
  type CliToolStore,
  type CommandSandbox,
  consoleLogger,
  createCliCapabilitySource,
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
  type VitalityStore,
  type Tool,
  type ToolRegistry,
} from '@cobble/core';
import type { Database } from '@cobble/db';
import type { AppConfig } from '../config.js';

export interface ToolAcquisitionWiring {
  /** The core tools advertised every step: native tools + search_tools + load_tool. */
  readonly nativeTools: readonly Tool[];
  /** Per-step registry resolver: core tools + the companion's equipped tools. */
  readonly resolveRegistry: (companionId: string) => Promise<ToolRegistry>;
  /** The RetrieveContext arm that lists the companion's currently-equipped tools. */
  readonly equippedArm: RetrieveContext;
  /** Bridges procedural recall → proactive loading: which routine tools to pick up. */
  readonly loadAdvisor: ToolLoadAdvisor;
  /** (Re)build the catalog from every configured source; returns the tools indexed. */
  readonly refreshCatalog: () => Promise<number>;
}

export interface BuildToolAcquisitionWiringOptions {
  readonly config: AppConfig;
  readonly db: Database;
  /** Speaks the MCP wire protocol (list/call); used when `MCP_SERVERS` is set. */
  readonly mcpGateway: McpGateway;
  /** Reads CLI tool definitions; used when `CLI_TOOLS_PATH` is set. */
  readonly cliToolStore?: CliToolStore;
  /** Runs whitelisted CLIs; used when `CLI_TOOLS_PATH` is set. */
  readonly cliSandbox?: CommandSandbox;
  /** The LLM gateway for the off-loop `search_tools` lookup. */
  readonly llmGateway: LlmGateway;
  /** The existing native tools (web_fetch, memory_search, ingest_source). */
  readonly baseTools: readonly Tool[];
  /** Bills the `search_tools` lookup to the owner's stamina; omit = unmetered. */
  readonly quota?: VitalityStore;
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

/** Compose the configured capability sources (MCP, CLI) from config + transports. */
function buildSources(
  options: BuildToolAcquisitionWiringOptions,
  logger: Logger,
): CapabilitySource[] {
  const { config } = options;
  const sources: CapabilitySource[] = [];
  if (config.mcpServers.length > 0) {
    sources.push(
      createMcpCapabilitySource({
        whitelist: new McpWhitelist(config.mcpServers),
        gateway: options.mcpGateway,
        authHeaders: envAuthHeaders,
        logger,
      }),
    );
  }
  if (config.cliToolsPath.length > 0 && options.cliToolStore && options.cliSandbox) {
    sources.push(
      createCliCapabilitySource({
        toolStore: options.cliToolStore,
        sandbox: options.cliSandbox,
        logger,
      }),
    );
  }
  return sources;
}

/** Build the tool-acquisition wiring, or null when no source is configured (feature off). */
export function buildToolAcquisitionWiring(
  options: BuildToolAcquisitionWiringOptions,
): ToolAcquisitionWiring | null {
  const { db, llmGateway } = options;
  const logger = options.logger ?? consoleLogger;
  const sources = buildSources(options, logger);
  if (sources.length === 0) {
    return null;
  }
  const catalog = new DrizzleToolCatalogStore(db);
  const equipped = new DrizzleEquippedToolStore(db);

  const searchTool = createSearchToolsTool({
    catalog,
    gateway: llmGateway,
    model: options.config.ingestionModel,
    ...(options.quota ? { quota: options.quota } : {}),
    logger,
  });
  const loadTool = createLoadToolTool({
    catalog,
    equipped,
    sources,
    maxEquippedTools: options.config.maxEquippedTools,
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
