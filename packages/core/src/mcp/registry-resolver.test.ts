/** createMcpRegistryResolver: native + connected MCP tools, de-whitelist revocation. */

import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import type { Tool } from '../tools/tool.js';
import type {
  McpConnectionRecord,
  McpConnectionStore,
  UpsertConnectionInput,
} from './connection-store.js';
import { FakeMcpGateway } from './fake.js';
import type { McpToolDef } from './gateway.js';
import { createMcpRegistryResolver } from './registry-resolver.js';
import { McpWhitelist } from './whitelist.js';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};
const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };

const getQuote: McpToolDef = {
  name: 'get_quote',
  description: 'Get a realtime stock quote.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
};

const nativeTool: Tool = {
  name: 'web_fetch',
  description: 'fetch',
  parameters: { type: 'object', properties: {} },
  effectful: false,
  async run() {
    return { name: 'web_fetch', content: 'native' };
  },
};

/** A connection store whose `list` returns preset rows. */
function fakeConnections(
  rows: ReadonlyArray<{
    serverRef: string;
    toolsSnapshot: readonly McpToolDef[];
    status?: 'connected' | 'error';
  }>,
): McpConnectionStore {
  const records: McpConnectionRecord[] = rows.map((row, index) => ({
    id: `id-${index}`,
    companionId: 'c1',
    serverRef: row.serverRef,
    toolsSnapshot: row.toolsSnapshot,
    status: row.status ?? 'connected',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  }));
  return {
    async list(): Promise<readonly McpConnectionRecord[]> {
      return records;
    },
    async upsert(_c: string, _i: UpsertConnectionInput): Promise<McpConnectionRecord> {
      throw new Error('not used');
    },
    async get(): Promise<McpConnectionRecord | null> {
      return null;
    },
  };
}

const whitelist = new McpWhitelist([{ ref: 'stocks', endpoint: 'https://mcp.example.com' }]);

describe('createMcpRegistryResolver', () => {
  it('composes native tools with the tools of a connected server', async () => {
    const gateway = new FakeMcpGateway({
      stocks: { tools: [getQuote], results: { get_quote: 'AAPL $190' } },
    });
    const resolve = createMcpRegistryResolver({
      nativeTools: [nativeTool],
      whitelist,
      connections: fakeConnections([{ serverRef: 'stocks', toolsSnapshot: [getQuote] }]),
      gateway,
      logger: silentLogger,
    });

    const registry = await resolve('c1');
    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['mcp__stocks__get_quote', 'web_fetch']);
    // The composed MCP tool actually proxies to the gateway when run.
    const mcpTool = registry.get('mcp__stocks__get_quote');
    const result = await mcpTool!.run({ symbol: 'AAPL' }, ctx);
    expect(result.content).toContain('AAPL $190');
  });

  it('omits tools from a server that has since dropped off the whitelist', async () => {
    const gateway = new FakeMcpGateway({ ghost: { tools: [getQuote] } });
    const resolve = createMcpRegistryResolver({
      nativeTools: [nativeTool],
      whitelist, // only 'stocks' is allowed; 'ghost' is not
      connections: fakeConnections([{ serverRef: 'ghost', toolsSnapshot: [getQuote] }]),
      gateway,
      logger: silentLogger,
    });
    const registry = await resolve('c1');
    expect(registry.list().map((t) => t.name)).toEqual(['web_fetch']);
  });

  it('skips error-status connections', async () => {
    const gateway = new FakeMcpGateway({ stocks: { tools: [getQuote] } });
    const resolve = createMcpRegistryResolver({
      nativeTools: [nativeTool],
      whitelist,
      connections: fakeConnections([
        { serverRef: 'stocks', toolsSnapshot: [getQuote], status: 'error' },
      ]),
      gateway,
      logger: silentLogger,
    });
    const registry = await resolve('c1');
    expect(registry.list().map((t) => t.name)).toEqual(['web_fetch']);
  });
});
