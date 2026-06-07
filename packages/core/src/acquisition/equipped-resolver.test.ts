/**
 * Equipped-registry-resolver tests: composes the core tools with the companion's
 * equipped tools (namespaced), drops a tool whose server left the whitelist, and
 * bumps a tool's recency when it is called (keeps the LRU honest). Exercised
 * through the MCP capability source, since the resolver is source-agnostic.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { ToolResult, TurnCtx } from '../harness/hooks.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySource } from './capability-source.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { Tool } from '../tools/tool.js';
import { createEquippedRegistryResolver } from './equipped-resolver.js';
import { DrizzleEquippedToolStore } from './equipped-store.js';
import { FakeMcpGateway } from '../mcp/fake.js';
import { createMcpCapabilitySource } from '../mcp/mcp-source.js';
import { McpWhitelist } from '../mcp/whitelist.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const nativeTool: Tool = {
  name: 'web_fetch',
  description: 'fetch',
  parameters: { type: 'object', properties: {} },
  effectful: false,
  run: async (): Promise<ToolResult> => ({ name: 'web_fetch', content: 'ok' }),
};

const snapshot = { name: 'get_quote', description: 'quote', inputSchema: { type: 'object' } };

describe('createEquippedRegistryResolver', () => {
  let db: Database;
  let close: () => Promise<void>;
  let equipped: DrizzleEquippedToolStore;
  let ctx: TurnCtx;

  const whitelist = new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]);
  /** Wrap the whitelist + a gateway as the MCP capability source the resolver adapts through. */
  const sources = (gateway: FakeMcpGateway): readonly CapabilitySource[] => [
    createMcpCapabilitySource({ whitelist, gateway, logger: silentLogger }),
  ];

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    equipped = new DrizzleEquippedToolStore(db);
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('o@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    ctx = { companionId: companion.id, ownerId: user.id };
  });
  afterEach(async () => {
    await close();
  });

  it('composes the core tools with equipped tools (namespaced)', async () => {
    await equipped.equip(ctx.companionId, {
      toolId: 'mcp__stocks__get_quote',
      source: 'mcp',
      serverRef: 'stocks',
      snapshot,
    });
    const resolve = createEquippedRegistryResolver({
      nativeTools: [nativeTool],
      equipped,
      sources: sources(new FakeMcpGateway({ stocks: { tools: [snapshot] } })),
      logger: silentLogger,
    });
    const registry = await resolve(ctx.companionId);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain('web_fetch');
    expect(names).toContain('mcp__stocks__get_quote');
  });

  it('drops an equipped tool whose server left the whitelist', async () => {
    await equipped.equip(ctx.companionId, {
      toolId: 'mcp__ghost__do',
      source: 'mcp',
      serverRef: 'ghost',
      snapshot: { name: 'do', description: 'do', inputSchema: { type: 'object' } },
    });
    const resolve = createEquippedRegistryResolver({
      nativeTools: [nativeTool],
      equipped,
      sources: sources(new FakeMcpGateway({})),
      logger: silentLogger,
    });
    const names = (await resolve(ctx.companionId)).list().map((t) => t.name);
    expect(names).not.toContain('mcp__ghost__do');
    expect(names).toContain('web_fetch');
  });

  it('bumps recency when an equipped tool is called', async () => {
    let clock = new Date('2026-06-06T00:00:00Z');
    const clocked = new DrizzleEquippedToolStore(db, { now: () => clock });
    await clocked.equip(ctx.companionId, {
      toolId: 'mcp__stocks__get_quote',
      source: 'mcp',
      serverRef: 'stocks',
      snapshot,
    });
    const resolve = createEquippedRegistryResolver({
      nativeTools: [nativeTool],
      equipped: clocked,
      sources: sources(new FakeMcpGateway({ stocks: { tools: [snapshot] } })),
      logger: silentLogger,
    });
    const registry = await resolve(ctx.companionId);
    const tool = registry.get('mcp__stocks__get_quote');
    clock = new Date('2026-06-06T01:00:00Z'); // time passes before the call
    await tool?.run({ symbol: 'ABC' }, ctx);
    const record = await clocked.get(ctx.companionId, 'mcp__stocks__get_quote');
    expect(record?.lastUsedAt.toISOString()).toBe('2026-06-06T01:00:00.000Z');
  });
});
