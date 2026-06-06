/** The MCP tool-retrieval arm: surface relevant connected tools as a hint; degrade safely. */

import { describe, expect, it } from 'vitest';
import type {
  McpConnectionRecord,
  McpConnectionStore,
  UpsertConnectionInput,
} from '../mcp/connection-store.js';
import type { McpToolDef } from '../mcp/gateway.js';
import type { Logger } from '../logging.js';
import { createToolRetrieveContext } from './tool-retrieve.js';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

const getQuote: McpToolDef = {
  name: 'get_quote',
  description: 'Get a realtime stock quote for a ticker symbol.',
  inputSchema: { type: 'object', properties: {} },
};
const weather: McpToolDef = {
  name: 'forecast',
  description: 'Return the weather forecast for a city.',
  inputSchema: { type: 'object', properties: {} },
};

/** A connection store whose `list` returns preset rows (the arm only reads `list`). */
function fakeConnections(
  rows: ReadonlyArray<{
    serverRef: string;
    toolsSnapshot: readonly McpToolDef[];
    status?: 'connected' | 'error';
  }>,
  onList?: () => never,
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
      onList?.();
      return records;
    },
    async upsert(
      _companionId: string,
      _input: UpsertConnectionInput,
    ): Promise<McpConnectionRecord> {
      throw new Error('not used');
    },
    async get(): Promise<McpConnectionRecord | null> {
      return null;
    },
  };
}

describe('createToolRetrieveContext', () => {
  it('surfaces a relevant connected tool as a system hint with its advertised name', async () => {
    const arm = createToolRetrieveContext({
      connections: fakeConnections([{ serverRef: 'stocks', toolsSnapshot: [getQuote] }]),
      logger: silentLogger,
    });
    const { blocks, usage } = await arm({
      companionId: 'c1',
      userContent: 'what is the AAPL stock quote?',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe('system');
    expect(blocks[0]?.content).toContain('mcp__stocks__get_quote');
    expect(blocks[0]?.content).toContain('realtime stock quote');
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('returns no hint when nothing matches the turn', async () => {
    const arm = createToolRetrieveContext({
      connections: fakeConnections([{ serverRef: 'weather', toolsSnapshot: [weather] }]),
      logger: silentLogger,
    });
    const { blocks } = await arm({ companionId: 'c1', userContent: 'tell me a joke' });
    expect(blocks).toEqual([]);
  });

  it('only ranks the most relevant tool to the top across servers', async () => {
    const arm = createToolRetrieveContext({
      connections: fakeConnections([
        { serverRef: 'stocks', toolsSnapshot: [getQuote] },
        { serverRef: 'weather', toolsSnapshot: [weather] },
      ]),
      logger: silentLogger,
    });
    const { blocks } = await arm({ companionId: 'c1', userContent: 'stock quote please' });
    expect(blocks[0]?.content).toContain('mcp__stocks__get_quote');
    expect(blocks[0]?.content).not.toContain('mcp__weather__forecast');
  });

  it('skips tools from error-status connections', async () => {
    const arm = createToolRetrieveContext({
      connections: fakeConnections([
        { serverRef: 'stocks', toolsSnapshot: [getQuote], status: 'error' },
      ]),
      logger: silentLogger,
    });
    const { blocks } = await arm({ companionId: 'c1', userContent: 'stock quote' });
    expect(blocks).toEqual([]);
  });

  it('degrades to no hint when the store throws', async () => {
    const arm = createToolRetrieveContext({
      connections: fakeConnections([], () => {
        throw new Error('db down');
      }),
      logger: silentLogger,
    });
    const { blocks } = await arm({ companionId: 'c1', userContent: 'stock quote' });
    expect(blocks).toEqual([]);
  });
});
