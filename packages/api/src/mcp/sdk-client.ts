/**
 * The production MCP gateway: the official MCP SDK's Streamable HTTP client behind
 * the core {@link McpGateway} interface (companion-tools.md §7). Mirrors the
 * Langfuse adapter pattern — the concrete transport lives in the api package; core
 * owns only the interface + the test fake. HTTP/SSE only (no stdio on a
 * multi-tenant host). One Client per server ref, connected lazily and cached; a
 * failed connect is not cached so the next call retries.
 *
 * SSRF defense is layered, matching link ingestion (companion-tools.md §7):
 * the whitelist endpoint is string-validated (`assertPublicHttpUrl`) and
 * load_tool re-checks it, and — the part that actually stops DNS
 * rebinding — every transport connection resolves through {@link ssrfSafeFetch},
 * whose connection-layer DNS lookup rejects any address in a private/metadata
 * range. String checks alone can't catch a public hostname pointing at an
 * internal IP; the guarded fetch can.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  consoleLogger,
  type Logger,
  type McpCallResult,
  type McpGateway,
  McpGatewayError,
  type McpServerSpec,
  type McpToolDef,
  ssrfSafeFetch,
} from '@cobble/core';

const CLIENT_INFO = { name: 'cobble-companion', version: '0.0.0' } as const;

/**
 * Build the transport options for a server spec: route every connection
 * through the SSRF-guarded fetch (DNS-rebinding defense) and forward the
 * optional auth headers. Exported so the wiring is unit-testable without a
 * live server.
 */
export function mcpTransportOptions(spec: McpServerSpec): StreamableHTTPClientTransportOptions {
  return {
    fetch: ssrfSafeFetch,
    ...(spec.headers ? { requestInit: { headers: spec.headers } } : {}),
  };
}

/** A text/non-text content block as the SDK returns it from `tools/call`. */
type McpContentBlock = { readonly type: string; readonly text?: string };

/**
 * The slice of the MCP SDK `Client` this gateway actually depends on. Connecting
 * is the one piece that needs a live network + the concrete SDK, so it is the
 * seam: the default connector ({@link connectSdkClient}) speaks real Streamable
 * HTTP, while tests inject a fake to exercise listTools/callTool/the client cache
 * without a server.
 */
export interface McpClientLike {
  listTools(): Promise<{
    tools: readonly { name: string; description?: string; inputSchema: Record<string, unknown> }[];
  }>;
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

/** Connect to a whitelisted server and return a ready client. Injectable for tests. */
export type McpClientConnector = (spec: McpServerSpec) => Promise<McpClientLike>;

/** The production connector: real Streamable HTTP through the SSRF-guarded fetch. */
export async function connectSdkClient(spec: McpServerSpec): Promise<McpClientLike> {
  const transport = new StreamableHTTPClientTransport(
    new URL(spec.endpoint),
    mcpTransportOptions(spec),
  );
  const client = new Client(CLIENT_INFO);
  // The SDK's StreamableHTTPClientTransport exposes `sessionId: string | undefined`,
  // which trips our exactOptionalPropertyTypes against its own `Transport` type — a
  // library typing quirk, not a real incompatibility. Assert at the seam.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client as unknown as McpClientLike;
}

export class StreamableHttpMcpGateway implements McpGateway {
  private readonly clients = new Map<string, Promise<McpClientLike>>();
  private readonly logger: Logger;
  private readonly connector: McpClientConnector;

  constructor(logger: Logger = consoleLogger, connector: McpClientConnector = connectSdkClient) {
    this.logger = logger;
    this.connector = connector;
  }

  async listTools(spec: McpServerSpec): Promise<readonly McpToolDef[]> {
    try {
      const client = await this.clientFor(spec);
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      }));
    } catch (error) {
      throw new McpGatewayError(`failed to list tools on "${spec.ref}"`, error);
    }
  }

  async callTool(
    spec: McpServerSpec,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    try {
      const client = await this.clientFor(spec);
      const result = await client.callTool({ name, arguments: args });
      return {
        content: flattenContent(result.content as readonly McpContentBlock[]),
        isError: result.isError === true,
      };
    } catch (error) {
      throw new McpGatewayError(`failed to call "${name}" on "${spec.ref}"`, error);
    }
  }

  async close(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      pending.map(async (clientPromise) => {
        try {
          await (await clientPromise).close();
        } catch (error) {
          this.logger.error('failed to close mcp client', { operation: 'mcp.close', error });
        }
      }),
    );
  }

  /** One connected client per server ref; the connect handshake runs once. */
  private clientFor(spec: McpServerSpec): Promise<McpClientLike> {
    const existing = this.clients.get(spec.ref);
    if (existing) {
      return existing;
    }
    const connecting = this.connector(spec);
    this.clients.set(spec.ref, connecting);
    // Don't cache a failed connect — drop it so a later call retries cleanly.
    void connecting.catch(() => this.clients.delete(spec.ref));
    return connecting;
  }
}

/** Flatten MCP content blocks to text; non-text blocks are noted by their type. */
function flattenContent(content: readonly McpContentBlock[]): string {
  return content
    .map((block) =>
      block.type === 'text' && block.text !== undefined ? block.text : `[${block.type}]`,
    )
    .join('\n');
}
