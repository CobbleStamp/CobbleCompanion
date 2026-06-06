/**
 * The MCP transport wiring: every connection must route through the
 * SSRF-guarded fetch so a whitelisted hostname that resolves to a
 * private/metadata IP is rejected at connect time (companion-tools.md §7).
 * The guard logic itself is covered by `ingestion/url-guard.test.ts`; here we
 * prove the transport is actually handed that guarded fetch.
 */

import { ssrfSafeFetch, type McpServerSpec } from '@cobble/core';
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
