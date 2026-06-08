/**
 * CLI capability-source integration: a CLI tool flows discover → load → call over
 * the same spine the MCP source uses (catalog builder + load_tool + per-step
 * registry), against the fake sandbox. Covers: catalog enumeration from the store;
 * load equips with the fresh usage + schema; the resolver adapts a callable tool;
 * removing the tool revokes it (pruned from the catalog, dropped by the resolver,
 * denied at call time); and an MCP source + a CLI source compose into one catalog
 * and one registry without collision.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TurnCtx } from '../harness/hooks.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import { refreshToolCatalog } from '../acquisition/catalog-builder.js';
import { createMcpCapabilitySource } from '../mcp/mcp-source.js';
import { FakeMcpGateway } from '../mcp/fake.js';
import { McpWhitelist } from '../mcp/whitelist.js';
import { DrizzleEquippedToolStore } from '../acquisition/equipped-store.js';
import { DrizzleToolCatalogStore } from '../acquisition/tool-catalog-store.js';
import { createLoadToolTool } from '../acquisition/load-tool.js';
import { createEquippedRegistryResolver } from '../acquisition/equipped-resolver.js';
import { createCliCapabilitySource } from './cli-source.js';
import { type CommandResult, FakeCommandSandbox } from './sandbox.js';
import { parseCliToolDef } from './tool-def.js';
import { InMemoryCliToolStore } from './tool-store.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const greetDef = parseCliToolDef(
  'greet',
  JSON.stringify({
    binary: 'echo',
    description: 'Print a greeting for a name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    argv: ['hello', '{name}'],
    limits: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
  }),
  '# greet\nPrint a friendly greeting.',
);

const echoSandbox = new FakeCommandSandbox(
  (req): CommandResult => ({
    output: req.argv.join(' '),
    exitCode: 0,
    timedOut: false,
    truncated: false,
  }),
);

describe('CLI capability source (over the shared spine)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let catalog: DrizzleToolCatalogStore;
  let equipped: DrizzleEquippedToolStore;
  let ctx: TurnCtx;

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
  });
  afterEach(async () => {
    await close();
  });

  it('discovers, loads, and calls a CLI tool', async () => {
    const store = new InMemoryCliToolStore([greetDef]);
    const cli = createCliCapabilitySource({
      toolStore: store,
      sandbox: echoSandbox,
      logger: silentLogger,
    });

    // Catalog: a lightweight entry with the SHORT description (no schema).
    await refreshToolCatalog({ sources: [cli], catalog, logger: silentLogger });
    const entry = await catalog.get('cli__greet');
    expect(entry).toMatchObject({ source: 'cli', serverRef: 'greet', toolName: 'greet' });
    expect(entry?.description).toBe('Print a greeting for a name.');

    // Load: equips with the FRESH usage prompt + arg schema.
    const loadTool = createLoadToolTool({
      catalog,
      equipped,
      sources: [cli],
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    const loaded = await loadTool.run({ tool_id: 'cli__greet' }, ctx);
    expect(loaded.isError).toBeUndefined();
    const record = await equipped.get(ctx.companionId, 'cli__greet');
    expect(record?.snapshot.description).toContain('Print a friendly greeting.');

    // Call: the per-step registry adapts it; the sandbox receives the rendered argv.
    const resolve = createEquippedRegistryResolver({
      nativeTools: [],
      equipped,
      sources: [cli],
      logger: silentLogger,
    });
    const tool = (await resolve(ctx.companionId)).get('cli__greet');
    expect(tool).toBeDefined();
    const result = await tool!.run({ name: 'Pip' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hello Pip');
  });

  it('revokes a tool when it is removed from the store', async () => {
    const store = new InMemoryCliToolStore([greetDef]);
    const cli = createCliCapabilitySource({
      toolStore: store,
      sandbox: echoSandbox,
      logger: silentLogger,
    });
    await refreshToolCatalog({ sources: [cli], catalog, logger: silentLogger });
    const loadTool = createLoadToolTool({
      catalog,
      equipped,
      sources: [cli],
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    await loadTool.run({ tool_id: 'cli__greet' }, ctx);

    // The tool folder is removed; a refresh prunes the catalog + updates admissibility.
    store.remove('greet');
    await refreshToolCatalog({ sources: [cli], catalog, logger: silentLogger });
    expect(await catalog.get('cli__greet')).toBeNull();

    // The resolver no longer advertises it, and a stale equipped row is dropped.
    const resolve = createEquippedRegistryResolver({
      nativeTools: [],
      equipped,
      sources: [cli],
      logger: silentLogger,
    });
    const names = (await resolve(ctx.companionId)).list().map((t) => t.name);
    expect(names).not.toContain('cli__greet');
  });

  it('denies a call at run time when the definition vanished mid-conversation', async () => {
    const store = new InMemoryCliToolStore([greetDef]);
    const cli = createCliCapabilitySource({
      toolStore: store,
      sandbox: echoSandbox,
      logger: silentLogger,
    });
    await refreshToolCatalog({ sources: [cli], catalog, logger: silentLogger });
    const loadTool = createLoadToolTool({
      catalog,
      equipped,
      sources: [cli],
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    await loadTool.run({ tool_id: 'cli__greet' }, ctx);
    const resolve = createEquippedRegistryResolver({
      nativeTools: [],
      equipped,
      sources: [cli],
      logger: silentLogger,
    });
    const tool = (await resolve(ctx.companionId)).get('cli__greet');
    // Folder removed AFTER the registry was resolved (still admissible in the cache,
    // but the call-time re-read finds nothing) → the call is denied, no sandbox run.
    store.remove('greet');
    const result = await tool!.run({ name: 'Pip' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no longer available');
  });

  it('composes with the MCP source in one catalog and one registry', async () => {
    const store = new InMemoryCliToolStore([greetDef]);
    const cli = createCliCapabilitySource({
      toolStore: store,
      sandbox: echoSandbox,
      logger: silentLogger,
    });
    const mcp = createMcpCapabilitySource({
      whitelist: new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]),
      gateway: new FakeMcpGateway({
        stocks: {
          tools: [
            { name: 'get_quote', description: 'Get a quote.', inputSchema: { type: 'object' } },
          ],
        },
      }),
      logger: silentLogger,
    });
    const sources = [mcp, cli];

    const count = await refreshToolCatalog({ sources, catalog, logger: silentLogger });
    expect(count).toBe(2);
    const ids = (await catalog.list()).map((e) => e.toolId).sort();
    expect(ids).toEqual(['cli__greet', 'mcp__stocks__get_quote']);

    const loadTool = createLoadToolTool({
      catalog,
      equipped,
      sources,
      maxEquippedTools: 8,
      logger: silentLogger,
    });
    await loadTool.run({ tool_id: 'cli__greet' }, ctx);
    await loadTool.run({ tool_id: 'mcp__stocks__get_quote' }, ctx);

    const resolve = createEquippedRegistryResolver({
      nativeTools: [],
      equipped,
      sources,
      logger: silentLogger,
    });
    const names = (await resolve(ctx.companionId))
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['cli__greet', 'mcp__stocks__get_quote']);
  });
});
