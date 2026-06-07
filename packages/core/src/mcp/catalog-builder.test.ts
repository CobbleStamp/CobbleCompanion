/**
 * Catalog-builder tests: indexes every whitelisted server's tools as lightweight
 * entries (no argument schema); prunes a server that left the whitelist; and on a
 * server that fails to list, keeps that server's prior (stale) entries rather than
 * dropping them — an outage never empties the catalog. Exercised through the MCP
 * capability source, since the builder is source-agnostic.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilitySource } from '../acquisition/capability-source.js';
import { refreshToolCatalog } from './catalog-builder.js';
import { FakeMcpGateway } from './fake.js';
import {
  type McpGateway,
  McpGatewayError,
  type McpServerSpec,
  type McpToolDef,
} from './gateway.js';
import { createMcpCapabilitySource } from './mcp-source.js';
import { DrizzleToolCatalogStore } from './tool-catalog-store.js';
import { McpWhitelist } from './whitelist.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

/** The catalog builder takes capability sources — wrap a whitelist + gateway as one. */
const mcpSources = (whitelist: McpWhitelist, gateway: McpGateway): readonly CapabilitySource[] => [
  createMcpCapabilitySource({ whitelist, gateway, logger: silentLogger }),
];

const quote: McpToolDef = {
  name: 'get_quote',
  description: 'Get a realtime stock quote.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
};
const top: McpToolDef = {
  name: 'top',
  description: 'Top headlines.',
  inputSchema: { type: 'object' },
};

describe('refreshToolCatalog', () => {
  let db: Database;
  let close: () => Promise<void>;
  let catalog: DrizzleToolCatalogStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    catalog = new DrizzleToolCatalogStore(db);
  });
  afterEach(async () => {
    await close();
  });

  it('indexes whitelisted tools as lightweight entries (no schema)', async () => {
    const whitelist = new McpWhitelist([
      { ref: 'stocks', endpoint: 'https://s.example.com' },
      { ref: 'news', endpoint: 'https://n.example.com' },
    ]);
    const gateway = new FakeMcpGateway({
      stocks: { tools: [quote] },
      news: { tools: [top] },
    });
    const count = await refreshToolCatalog({
      sources: mcpSources(whitelist, gateway),
      catalog,
      logger: silentLogger,
    });
    expect(count).toBe(2);
    const ids = (await catalog.list()).map((e) => e.toolId).sort();
    expect(ids).toEqual(['mcp__news__top', 'mcp__stocks__get_quote']);
    // The entry carries name + description, never the inputSchema.
    const entry = await catalog.get('mcp__stocks__get_quote');
    expect(entry).toMatchObject({ toolName: 'get_quote', source: 'mcp', serverRef: 'stocks' });
    expect(Object.keys(entry ?? {})).not.toContain('inputSchema');
  });

  it('prunes entries for a server that left the whitelist', async () => {
    const gateway = new FakeMcpGateway({ stocks: { tools: [quote] }, news: { tools: [top] } });
    await refreshToolCatalog({
      sources: mcpSources(
        new McpWhitelist([
          { ref: 'stocks', endpoint: 'https://s.example.com' },
          { ref: 'news', endpoint: 'https://n.example.com' },
        ]),
        gateway,
      ),
      catalog,
      logger: silentLogger,
    });
    // news is dropped from the whitelist on the next refresh.
    await refreshToolCatalog({
      sources: mcpSources(
        new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]),
        gateway,
      ),
      catalog,
      logger: silentLogger,
    });
    const ids = (await catalog.list()).map((e) => e.toolId);
    expect(ids).toEqual(['mcp__stocks__get_quote']);
  });

  it('keeps a still-whitelisted server’s stale entries when it fails to list', async () => {
    await refreshToolCatalog({
      sources: mcpSources(
        new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]),
        new FakeMcpGateway({ stocks: { tools: [quote] } }),
      ),
      catalog,
      logger: silentLogger,
    });
    // The server is unreachable this pass; its prior entry must survive.
    const downGateway: McpGateway = {
      async listTools(_spec: McpServerSpec): Promise<readonly McpToolDef[]> {
        throw new McpGatewayError('unreachable');
      },
      async callTool() {
        throw new McpGatewayError('unreachable');
      },
    };
    await refreshToolCatalog({
      sources: mcpSources(
        new McpWhitelist([{ ref: 'stocks', endpoint: 'https://s.example.com' }]),
        downGateway,
      ),
      catalog,
      logger: silentLogger,
    });
    expect((await catalog.list()).map((e) => e.toolId)).toEqual(['mcp__stocks__get_quote']);
  });
});
