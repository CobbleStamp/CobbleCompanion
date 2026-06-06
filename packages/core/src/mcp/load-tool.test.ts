/**
 * load_tool tests: equips a catalog tool with its FRESH schema (not the catalog
 * stub); denies an off-catalog id; denies a tool whose server left the whitelist;
 * and enforces the loaded-tier cap by evicting the LRU on overflow. Never throws.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { TurnCtx } from '../harness/hooks.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleEquippedToolStore } from './equipped-store.js';
import { FakeMcpGateway } from './fake.js';
import { type McpToolDef } from './gateway.js';
import { createLoadToolTool } from './load-tool.js';
import { DrizzleToolCatalogStore } from './tool-catalog-store.js';
import { McpWhitelist } from './whitelist.js';
import { DrizzleIdentityStore } from '../identity/store.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const freshQuote: McpToolDef = {
  name: 'get_quote',
  description: 'Get a realtime stock quote (fresh).',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
};

describe('load_tool', () => {
  let db: Database;
  let close: () => Promise<void>;
  let catalog: DrizzleToolCatalogStore;
  let equipped: DrizzleEquippedToolStore;
  let ctx: TurnCtx;

  const whitelist = new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]);
  const gateway = (): FakeMcpGateway => new FakeMcpGateway({ stocks: { tools: [freshQuote] } });

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    catalog = new DrizzleToolCatalogStore(db);
    equipped = new DrizzleEquippedToolStore(db);
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('o@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    ctx = { companionId: companion.id, ownerId: user.id };
    await catalog.upsert([
      {
        toolId: 'mcp__stocks__get_quote',
        source: 'mcp',
        serverRef: 'stocks',
        toolName: 'get_quote',
        description: 'stale stub description',
      },
    ]);
  });
  afterEach(async () => {
    await close();
  });

  it('equips a catalog tool with its fresh schema', async () => {
    const tool = createLoadToolTool({
      catalog,
      equipped,
      gateway: gateway(),
      whitelist,
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    const result = await tool.run({ tool_id: 'mcp__stocks__get_quote' }, ctx);
    expect(result.isError).toBeUndefined();
    const record = await equipped.get(ctx.companionId, 'mcp__stocks__get_quote');
    // The authoritative schema is fetched fresh, not copied from the catalog stub.
    expect(record?.snapshot.description).toBe('Get a realtime stock quote (fresh).');
    expect(record?.snapshot.inputSchema).toMatchObject({ required: ['symbol'] });
  });

  it('denies an id that is not in the catalog', async () => {
    const tool = createLoadToolTool({
      catalog,
      equipped,
      gateway: gateway(),
      whitelist,
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    const result = await tool.run({ tool_id: 'mcp__evil__rm' }, ctx);
    expect(result.isError).toBe(true);
    expect(await equipped.list(ctx.companionId)).toHaveLength(0);
  });

  it('denies a catalog tool whose server is no longer whitelisted', async () => {
    await catalog.upsert([
      {
        toolId: 'mcp__ghost__do',
        source: 'mcp',
        serverRef: 'ghost',
        toolName: 'do',
        description: 'orphaned entry',
      },
    ]);
    const tool = createLoadToolTool({
      catalog,
      equipped,
      gateway: gateway(),
      whitelist,
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    const result = await tool.run({ tool_id: 'mcp__ghost__do' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no longer available');
  });

  it('evicts the LRU when loading exceeds the loaded-tier cap', async () => {
    // Pre-equip a different tool, then load with budget 1 → the old one is evicted.
    await equipped.equip(ctx.companionId, {
      toolId: 'mcp__stocks__old',
      source: 'mcp',
      serverRef: 'stocks',
      snapshot: { name: 'old', description: 'old', inputSchema: { type: 'object' } },
    });
    const tool = createLoadToolTool({
      catalog,
      equipped,
      gateway: gateway(),
      whitelist,
      maxEquippedTools: 1,
      logger: silentLogger,
    });
    const result = await tool.run({ tool_id: 'mcp__stocks__get_quote' }, ctx);
    expect(result.content).toContain('Loaded');
    const ids = (await equipped.list(ctx.companionId)).map((r) => r.toolId);
    expect(ids).toEqual(['mcp__stocks__get_quote']);
  });
});
