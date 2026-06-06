/** connect_mcp: whitelist-gated connect → snapshot tools → persist; deny otherwise. */

import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import { createConnectMcpTool } from './connect-tool.js';
import {
  type McpConnectionRecord,
  type McpConnectionStore,
  type UpsertConnectionInput,
} from './connection-store.js';
import { FakeMcpGateway } from './fake.js';
import type { McpToolDef } from './gateway.js';
import { McpWhitelist } from './whitelist.js';

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };
const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};
const getQuote: McpToolDef = {
  name: 'get_quote',
  description: 'Get a realtime stock quote.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
};

/** Minimal in-memory connection store for tests (the Drizzle impl lands in slice 3). */
function memStore(): McpConnectionStore {
  const rows = new Map<string, McpConnectionRecord>();
  return {
    async upsert(companionId: string, input: UpsertConnectionInput): Promise<McpConnectionRecord> {
      const key = `${companionId}:${input.serverRef}`;
      const now = new Date();
      const record: McpConnectionRecord = {
        id: key,
        companionId,
        serverRef: input.serverRef,
        toolsSnapshot: input.toolsSnapshot,
        status: input.status,
        createdAt: rows.get(key)?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(key, record);
      return record;
    },
    async list(companionId: string): Promise<readonly McpConnectionRecord[]> {
      return [...rows.values()].filter((row) => row.companionId === companionId);
    },
    async get(companionId: string, serverRef: string): Promise<McpConnectionRecord | null> {
      return rows.get(`${companionId}:${serverRef}`) ?? null;
    },
  };
}

const whitelist = new McpWhitelist([{ ref: 'stocks', endpoint: 'https://mcp.example.com' }]);

describe('createConnectMcpTool', () => {
  it('advertises the available servers and is non-effectful', () => {
    const tool = createConnectMcpTool({
      whitelist,
      gateway: new FakeMcpGateway({ stocks: { tools: [getQuote] } }),
      connections: memStore(),
    });
    expect(tool.effectful).toBe(false);
    expect(tool.description).toContain('stocks');
    const server = (tool.parameters['properties'] as Record<string, { enum?: string[] }>)['server'];
    expect(server?.enum).toEqual(['stocks']);
  });

  it('connects a whitelisted server, snapshots its tools, and persists', async () => {
    const connections = memStore();
    const tool = createConnectMcpTool({
      whitelist,
      gateway: new FakeMcpGateway({ stocks: { tools: [getQuote] } }),
      connections,
    });
    const result = await tool.run({ server: 'stocks' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Connected to the "stocks"');
    expect(result.content).toContain('get_quote');
    const stored = await connections.get('c1', 'stocks');
    expect(stored?.status).toBe('connected');
    expect(stored?.toolsSnapshot).toEqual([getQuote]);
  });

  it('denies an off-whitelist server and persists nothing', async () => {
    const connections = memStore();
    const tool = createConnectMcpTool({
      whitelist,
      gateway: new FakeMcpGateway({ stocks: { tools: [getQuote] } }),
      connections,
    });
    const result = await tool.run({ server: 'evil' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not an available MCP server');
    expect(await connections.list('c1')).toHaveLength(0);
  });

  it('rejects a missing server arg as an error result', async () => {
    const tool = createConnectMcpTool({
      whitelist,
      gateway: new FakeMcpGateway({ stocks: { tools: [getQuote] } }),
      connections: memStore(),
    });
    const result = await tool.run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/needs a "server"/);
  });

  it('returns a connect failure as an error result and records the error status', async () => {
    const connections = memStore();
    // Whitelisted ref, but the gateway has no such server → listTools throws.
    const tool = createConnectMcpTool({
      whitelist,
      gateway: new FakeMcpGateway({}),
      connections,
      logger: silentLogger,
    });
    const result = await tool.run({ server: 'stocks' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error connecting to "stocks"');
    expect((await connections.get('c1', 'stocks'))?.status).toBe('error');
  });
});

describe('McpWhitelist', () => {
  it('rejects duplicate refs and non-public endpoints at construction', () => {
    expect(
      () =>
        new McpWhitelist([
          { ref: 'a', endpoint: 'https://x.example.com' },
          { ref: 'a', endpoint: 'https://y.example.com' },
        ]),
    ).toThrow(/duplicate/);
    expect(() => new McpWhitelist([{ ref: 'b', endpoint: 'http://localhost:9000' }])).toThrow();
  });
});
