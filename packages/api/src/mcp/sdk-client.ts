/**
 * The production MCP gateway: the official MCP SDK's Streamable HTTP client behind
 * the core {@link McpGateway} interface (companion-tools.md §7). Mirrors the
 * Langfuse adapter pattern — the concrete transport lives in the api package; core
 * owns only the interface + the test fake. HTTP/SSE only (no stdio on a
 * multi-tenant host). One Client per server ref, connected lazily and cached; a
 * failed connect is not cached so the next call retries. SSRF is enforced upstream
 * (the whitelist endpoint is validated and connect_mcp re-checks it).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  consoleLogger,
  type Logger,
  type McpCallResult,
  type McpGateway,
  McpGatewayError,
  type McpServerSpec,
  type McpToolDef,
} from '@cobble/core';

const CLIENT_INFO = { name: 'cobble-companion', version: '0.0.0' } as const;

/** A text/non-text content block as the SDK returns it from `tools/call`. */
type McpContentBlock = { readonly type: string; readonly text?: string };

export class StreamableHttpMcpGateway implements McpGateway {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.logger = logger;
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

  /** One connected {@link Client} per server ref; the connect handshake runs once. */
  private clientFor(spec: McpServerSpec): Promise<Client> {
    const existing = this.clients.get(spec.ref);
    if (existing) {
      return existing;
    }
    const connecting = this.connect(spec);
    this.clients.set(spec.ref, connecting);
    // Don't cache a failed connect — drop it so a later call retries cleanly.
    void connecting.catch(() => this.clients.delete(spec.ref));
    return connecting;
  }

  private async connect(spec: McpServerSpec): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(spec.endpoint), {
      ...(spec.headers ? { requestInit: { headers: spec.headers } } : {}),
    });
    const client = new Client(CLIENT_INFO);
    // The SDK's StreamableHTTPClientTransport exposes `sessionId: string | undefined`,
    // which trips our exactOptionalPropertyTypes against its own `Transport` type — a
    // library typing quirk, not a real incompatibility. Assert at the seam.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    return client;
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
