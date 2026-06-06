/**
 * The MCP transport wiring: every connection must route through the
 * SSRF-guarded fetch so a whitelisted hostname that resolves to a
 * private/metadata IP is rejected at connect time (companion-tools.md §7).
 * The guard logic itself is covered by `ingestion/url-guard.test.ts`; here we
 * prove the transport is actually handed that guarded fetch.
 */

import { ssrfSafeFetch, type McpServerSpec } from '@cobble/core';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { mcpTransportOptions } from './sdk-client.js';

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
