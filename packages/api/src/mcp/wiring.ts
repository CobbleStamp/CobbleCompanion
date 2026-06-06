/**
 * Assemble the MCP tool-acquisition wiring (companion-tools.md §4) shared by the
 * production graph (index.ts) and the test app (test/helpers.ts): the whitelist,
 * the per-companion connection store, the `connect_mcp` tool, the per-companion
 * registry resolver, and the tool-retrieval arm. Returns null when no servers are
 * whitelisted, so acquisition stays entirely off (behaviour unchanged) unless an
 * operator configures `MCP_SERVERS`.
 */

import {
  consoleLogger,
  createConnectMcpTool,
  createMcpRegistryResolver,
  createToolRetrieveContext,
  DrizzleMcpConnectionStore,
  type Logger,
  type McpGateway,
  type McpWhitelistEntry,
  McpWhitelist,
  type RetrieveContext,
  type Tool,
  type ToolRegistry,
} from '@cobble/core';
import type { Database } from '@cobble/db';
import type { AppConfig } from '../config.js';

export interface McpWiring {
  /** The native tool set extended with `connect_mcp` (registry + gate input). */
  readonly nativeTools: readonly Tool[];
  /** Per-turn registry resolver: native + the companion's connected MCP tools. */
  readonly resolveRegistry: (companionId: string) => Promise<ToolRegistry>;
  /** The RetrieveContext arm that hints the fitting connected tool. */
  readonly toolArm: RetrieveContext;
}

export interface BuildMcpWiringOptions {
  readonly config: AppConfig;
  readonly db: Database;
  readonly gateway: McpGateway;
  /** The existing native tools (web_fetch, memory_search, ingest_source). */
  readonly baseTools: readonly Tool[];
  readonly logger?: Logger;
}

/** Resolve a server's bearer-token from its whitelisted env-var name (server host). */
function envAuthHeaders(entry: McpWhitelistEntry): Readonly<Record<string, string>> | undefined {
  if (!entry.authTokenEnv) {
    return undefined;
  }
  const token = process.env[entry.authTokenEnv];
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** Build the MCP wiring, or null when no servers are whitelisted (feature off). */
export function buildMcpWiring(options: BuildMcpWiringOptions): McpWiring | null {
  const { config, db, gateway } = options;
  if (config.mcpServers.length === 0) {
    return null;
  }
  const logger = options.logger ?? consoleLogger;
  const whitelist = new McpWhitelist(config.mcpServers);
  const connections = new DrizzleMcpConnectionStore(db);
  const connectTool = createConnectMcpTool({
    whitelist,
    gateway,
    connections,
    authHeaders: envAuthHeaders,
    logger,
  });
  const nativeTools: readonly Tool[] = [...options.baseTools, connectTool];
  const resolveRegistry = createMcpRegistryResolver({
    nativeTools,
    whitelist,
    connections,
    gateway,
    authHeaders: envAuthHeaders,
    logger,
  });
  const toolArm = createToolRetrieveContext({ connections, logger });
  return { nativeTools, resolveRegistry, toolArm };
}
