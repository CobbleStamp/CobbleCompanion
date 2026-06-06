/**
 * The `connect_mcp` tool (companion-tools.md §6): connect the companion to a
 * **whitelisted** MCP server so its tools become callable. The whitelist is the
 * gate — a whitelisted ref connects freely (effectful:false, no propose→approve),
 * an unknown ref is denied as a result. On success it snapshots the server's
 * `tools/list` into the per-companion connection registry, so the tools rebuild
 * into the registry next turn (slice 3). Never throws — failures become results.
 */

import type { ToolResult } from '../harness/hooks.js';
import { assertPublicHttpUrl } from '../ingestion/url-guard.js';
import { consoleLogger, type Logger } from '../logging.js';
import { readStringArg, type Tool, toolErrorMessage } from '../tools/tool.js';
import type { McpConnectionStore } from './connection-store.js';
import type { McpGateway, McpServerSpec } from './gateway.js';
import type { McpWhitelist, McpWhitelistEntry } from './whitelist.js';

export interface ConnectMcpOptions {
  readonly whitelist: McpWhitelist;
  readonly gateway: McpGateway;
  readonly connections: McpConnectionStore;
  /** Build the request headers for a server (e.g. resolve its auth-token env). */
  readonly authHeaders?: (entry: McpWhitelistEntry) => Readonly<Record<string, string>> | undefined;
  readonly logger?: Logger;
}

export function createConnectMcpTool(options: ConnectMcpOptions): Tool {
  const logger = options.logger ?? consoleLogger;
  const refs = options.whitelist.list().map((entry) => entry.ref);
  const available = refs.length > 0 ? refs.join(', ') : 'none configured';
  return {
    name: 'connect_mcp',
    description:
      'Connect to one of the available external MCP servers by its ref, so its tools ' +
      `become callable this conversation. Available servers: ${available}.`,
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'The ref of the MCP server to connect to.',
          ...(refs.length > 0 ? { enum: refs } : {}),
        },
      },
      required: ['server'],
      additionalProperties: false,
    },
    effectful: false,
    stepSummary(args): string {
      return `Connected to ${readStringArg(args, 'server') ?? 'an MCP server'}`;
    },
    async run(rawArgs, ctx): Promise<ToolResult> {
      const ref = readStringArg(rawArgs, 'server');
      if (ref === null) {
        return {
          name: 'connect_mcp',
          content: 'Error: connect_mcp needs a "server" ref.',
          isError: true,
        };
      }
      const entry = options.whitelist.get(ref);
      if (!entry) {
        // Off-whitelist → denied (the whitelist is the entire gate, §6).
        return {
          name: 'connect_mcp',
          content: `Error: "${ref}" is not an available MCP server. Available: ${available}.`,
          isError: true,
        };
      }
      try {
        // Defense-in-depth: re-check the endpoint before connecting (the DNS-layer
        // re-validation rides in the gateway's transport, like link ingestion §8).
        assertPublicHttpUrl(entry.endpoint);
        const headers = options.authHeaders?.(entry);
        const spec: McpServerSpec = {
          ref: entry.ref,
          endpoint: entry.endpoint,
          ...(headers ? { headers } : {}),
        };
        const tools = await options.gateway.listTools(spec);
        await options.connections.upsert(ctx.companionId, {
          serverRef: entry.ref,
          toolsSnapshot: tools,
          status: 'connected',
        });
        const toolList = tools.length > 0 ? tools.map((tool) => tool.name).join(', ') : 'none';
        return {
          name: 'connect_mcp',
          content: `Connected to the "${entry.ref}" MCP server. Available tools: ${toolList}.`,
        };
      } catch (error) {
        logger.error('connect_mcp failed', {
          operation: 'mcp.connect',
          companionId: ctx.companionId,
          server: entry.ref,
          error,
        });
        // Record the failed attempt best-effort, so a surface can show it errored.
        await recordError(options.connections, ctx.companionId, entry.ref, logger);
        return {
          name: 'connect_mcp',
          content: `Error connecting to "${entry.ref}": ${toolErrorMessage(error)}`,
          isError: true,
        };
      }
    },
  };
}

/** Persist an `error` connection status; a logging-only failure must not mask the original error. */
async function recordError(
  connections: McpConnectionStore,
  companionId: string,
  serverRef: string,
  logger: Logger,
): Promise<void> {
  try {
    await connections.upsert(companionId, { serverRef, toolsSnapshot: [], status: 'error' });
  } catch (error) {
    logger.error('failed to record mcp connection error', {
      operation: 'mcp.connect.recordError',
      companionId,
      server: serverRef,
      error,
    });
  }
}
