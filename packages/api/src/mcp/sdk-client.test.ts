/**
 * The MCP transport wiring: every connection must route through the
 * SSRF-guarded fetch so a whitelisted hostname that resolves to a
 * private/metadata IP is rejected at connect time (companion-tools.md §7).
 * The guard logic itself is covered by `ingestion/url-guard.test.ts`; here we
 * prove the transport is actually handed that guarded fetch.
 */

import { McpGatewayError, ssrfSafeFetch, type McpServerSpec } from '@cobble/core';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { type McpClientLike, mcpTransportOptions, StreamableHttpMcpGateway } from './sdk-client.js';

describe('mcpTransportOptions', () => {
  it('routes connections through the SSRF-guarded fetch', () => {
    const spec: McpServerSpec = { ref: 'r', endpoint: 'https://example.com/mcp' };
    expect(mcpTransportOptions(spec).fetch).toBe(ssrfSafeFetch);
  });

  it('forwards auth headers without dropping the guarded fetch', () => {
    const spec: McpServerSpec = {
      ref: 'r',
      endpoint: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    };
    const options = mcpTransportOptions(spec);
    expect(options.fetch).toBe(ssrfSafeFetch);
    expect(options.requestInit?.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('omits requestInit when the spec carries no headers', () => {
    const spec: McpServerSpec = { ref: 'r', endpoint: 'https://example.com/mcp' };
    expect(mcpTransportOptions(spec).requestInit).toBeUndefined();
  });
});

/**
 * Canary against an SDK upgrade silently regressing the rebinding defense.
 * `mcpTransportOptions` hands the guarded fetch to the transport, but that only
 * matters if the SDK actually *uses* it on every channel — the string-level URL
 * check is the part `url-guard.ts` documents as insufficient. The transport
 * speaks over a POST request channel AND a GET Server-Sent-Events stream (with
 * reconnects), so a fetch consulted on only one channel would leave the other
 * exposed to DNS rebinding. We drive the real transport with a recording fetch
 * and assert both channels route through the supplied fetch — if the SDK ever
 * opened the SSE stream with the global fetch / a native EventSource, the
 * recorder would never see the GET.
 */
describe('StreamableHTTPClientTransport channel routing (SDK contract)', () => {
  it('routes both the GET SSE stream and the POST request channel through the supplied fetch', async () => {
    const calls: Array<{ method: string }> = [];
    // Canned responses that let each channel return without throwing:
    //   GET 405 → "server offers no SSE at GET" (expected, not an error)
    //   POST 202 → accepted, no body to process
    const recordingFetch = ((_url: unknown, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method });
      const status = method === 'GET' ? 405 : 202;
      return Promise.resolve(new Response(null, { status }));
    }) as unknown as typeof fetch;

    const spec: McpServerSpec = { ref: 'r', endpoint: 'https://example.com/mcp' };
    const transport = new StreamableHTTPClientTransport(new URL(spec.endpoint), {
      ...mcpTransportOptions(spec),
      fetch: recordingFetch,
    });

    // send() drives the POST request channel; resumeStream() opens the GET SSE
    // stream and is the very entry point auto-reconnect uses internally — so
    // covering it covers the reconnection path that the review flagged.
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await transport.resumeStream('event-1');
    await transport.close();

    const methods = calls.map((call) => call.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });
});

/**
 * The gateway methods that sit above the transport — tool listing, the
 * text-flattening of `tools/call` content, and the per-ref client cache (one
 * connect handshake per server, a failed connect not cached so the next call
 * retries). The connect step is the only piece that needs a live server, so we
 * inject a fake connector and drive the rest directly.
 */
describe('StreamableHttpMcpGateway', () => {
  const spec: McpServerSpec = { ref: 'stocks', endpoint: 'https://mcp.example.com/mcp' };

  /** A fake SDK client whose responses each test scripts; records its calls. */
  function fakeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
    return {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
      async close() {
        // no-op
      },
      ...overrides,
    };
  }

  type CountingConnector = ((spec: McpServerSpec) => Promise<McpClientLike>) & {
    readonly connects: number;
  };

  /** A connector that hands back the given client and counts how often it ran. */
  function countingConnector(client: McpClientLike): CountingConnector {
    let connects = 0;
    const connect = async (): Promise<McpClientLike> => {
      connects += 1;
      return client;
    };
    return Object.defineProperty(connect, 'connects', {
      get: () => connects,
    }) as unknown as CountingConnector;
  }

  it('lists tools, defaulting a missing description to the empty string', async () => {
    const client = fakeClient({
      async listTools() {
        return {
          tools: [
            { name: 'get_quote', description: 'Quote.', inputSchema: { type: 'object' } },
            { name: 'no_desc', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      },
    });
    const gateway = new StreamableHttpMcpGateway(undefined, async () => client);
    expect(await gateway.listTools(spec)).toEqual([
      { name: 'get_quote', description: 'Quote.', inputSchema: { type: 'object' } },
      { name: 'no_desc', description: '', inputSchema: { type: 'object', properties: {} } },
    ]);
  });

  it('joins text blocks with newlines and renders non-text blocks by type', async () => {
    const client = fakeClient({
      async callTool() {
        return {
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', data: '…' },
            { type: 'text', text: 'line two' },
          ],
        };
      },
    });
    const gateway = new StreamableHttpMcpGateway(undefined, async () => client);
    const result = await gateway.callTool(spec, 'get_quote', { symbol: 'AAPL' });
    expect(result).toEqual({ content: 'line one\n[image]\nline two', isError: false });
  });

  it('reports a server-flagged error result', async () => {
    const client = fakeClient({
      async callTool() {
        return { content: [{ type: 'text', text: 'rate limited' }], isError: true };
      },
    });
    const gateway = new StreamableHttpMcpGateway(undefined, async () => client);
    const result = await gateway.callTool(spec, 'get_quote', {});
    expect(result).toEqual({ content: 'rate limited', isError: true });
  });

  it('wraps a transport throw as an McpGatewayError from both methods', async () => {
    const client = fakeClient({
      async listTools() {
        throw new Error('socket hang up');
      },
      async callTool() {
        throw new Error('socket hang up');
      },
    });
    const gateway = new StreamableHttpMcpGateway(undefined, async () => client);
    await expect(gateway.callTool(spec, 'get_quote', {})).rejects.toBeInstanceOf(McpGatewayError);
    await expect(gateway.listTools(spec)).rejects.toBeInstanceOf(McpGatewayError);
  });

  it('connects once per ref and reuses the cached client across calls', async () => {
    const connector = countingConnector(
      fakeClient({
        async listTools() {
          return { tools: [{ name: 't', description: '', inputSchema: {} }] };
        },
      }),
    );
    const gateway = new StreamableHttpMcpGateway(undefined, connector);
    await gateway.listTools(spec);
    await gateway.callTool(spec, 't', {});
    await gateway.listTools(spec);
    expect(connector.connects).toBe(1);
  });

  it('does not cache a failed connect — the next call retries', async () => {
    let attempts = 0;
    const client = fakeClient({
      async listTools() {
        return { tools: [] };
      },
    });
    const flakyConnector = async (): Promise<McpClientLike> => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('connect refused');
      }
      return client;
    };
    const gateway = new StreamableHttpMcpGateway(undefined, flakyConnector);
    await expect(gateway.listTools(spec)).rejects.toBeInstanceOf(McpGatewayError);
    // The failed connect was dropped, so this call connects again rather than
    // re-throwing the cached failure.
    await expect(gateway.listTools(spec)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('closes and clears cached clients', async () => {
    let closed = 0;
    const connector = countingConnector(
      fakeClient({
        async close() {
          closed += 1;
        },
      }),
    );
    const gateway = new StreamableHttpMcpGateway(undefined, connector);
    await gateway.listTools(spec);
    await gateway.close();
    expect(closed).toBe(1);
    // Cache cleared: the next call connects afresh.
    await gateway.listTools(spec);
    expect(connector.connects).toBe(2);
  });
});
