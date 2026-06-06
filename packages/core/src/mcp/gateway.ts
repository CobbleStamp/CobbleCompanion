/**
 * Provider-agnostic MCP gateway (companion-tools.md §3). The companion reaches a
 * whitelisted external MCP server only through this interface; the wire protocol
 * lives in the SDK-backed implementation and the test fake (./fake.ts), mirroring
 * the LLM gateway seam so the transport can change without touching the tool
 * layer. HTTP/SSE transport only on the server host — no stdio (§7).
 */

/**
 * How to reach one whitelisted MCP server. Any auth rides in `headers`; that
 * value is resolved from the secret manager by the caller and is never persisted
 * (companion-tools.md §7).
 */
export interface McpServerSpec {
  /** Stable alias the whitelist and connection rows key on. */
  readonly ref: string;
  /** The server's HTTP/SSE endpoint URL (SSRF-validated before use). */
  readonly endpoint: string;
  /** Optional request headers (e.g. an Authorization bearer); not persisted. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A tool a server advertises, in MCP's `tools/list` shape. */
export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the call arguments (MCP `inputSchema`). */
  readonly inputSchema: Record<string, unknown>;
}

/** The flattened outcome of an MCP `tools/call` — text content + the server's error flag. */
export interface McpCallResult {
  readonly content: string;
  readonly isError: boolean;
}

/** Typed gateway failure — connection/protocol errors surface as data, not raw throws. */
export class McpGatewayError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'McpGatewayError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface McpGateway {
  /** List the tools a server advertises (MCP `tools/list`). Throws {@link McpGatewayError} on failure. */
  listTools(spec: McpServerSpec): Promise<readonly McpToolDef[]>;
  /** Invoke one tool on a server (MCP `tools/call`). Throws {@link McpGatewayError} on transport failure. */
  callTool(
    spec: McpServerSpec,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
  /** Release any held connections/sessions (best-effort). */
  close?(): Promise<void>;
}
