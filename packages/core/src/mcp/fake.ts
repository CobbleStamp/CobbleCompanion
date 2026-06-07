/**
 * Deterministic in-memory MCP gateway for tests and offline dev. Configured with
 * a set of fake servers (each: advertised tools + scripted call results) and
 * records every call for assertions. Per testing.md we fake our own gateway
 * interface rather than mock the MCP SDK client.
 */

import {
  type McpCallResult,
  type McpGateway,
  McpGatewayError,
  type McpServerSpec,
  type McpToolDef,
} from './gateway.js';

/** A fake server: the tools it advertises + optional scripted results per tool. */
export interface FakeMcpServer {
  readonly tools: readonly McpToolDef[];
  /** Tool name → result text or a full result; a missing entry echoes the args. */
  readonly results?: Readonly<Record<string, string | McpCallResult>>;
}

/** One recorded `callTool` invocation. */
export interface FakeMcpCall {
  readonly ref: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export class FakeMcpGateway implements McpGateway {
  /** Every `callTool` invocation, in order. */
  readonly calls: FakeMcpCall[] = [];
  private readonly servers: Readonly<Record<string, FakeMcpServer>>;

  constructor(servers: Readonly<Record<string, FakeMcpServer>> = {}) {
    this.servers = servers;
  }

  async listTools(spec: McpServerSpec): Promise<readonly McpToolDef[]> {
    return this.serverOf(spec).tools;
  }

  async callTool(
    spec: McpServerSpec,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    this.calls.push({ ref: spec.ref, name, args });
    const scripted = this.serverOf(spec).results?.[name];
    if (scripted === undefined) {
      return { content: `ok: ${name}(${JSON.stringify(args)})`, isError: false };
    }
    return typeof scripted === 'string' ? { content: scripted, isError: false } : scripted;
  }

  private serverOf(spec: McpServerSpec): FakeMcpServer {
    const server = this.servers[spec.ref];
    if (!server) {
      throw new McpGatewayError(`unknown MCP server "${spec.ref}"`);
    }
    return server;
  }
}
