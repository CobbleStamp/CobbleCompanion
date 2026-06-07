/**
 * search_tools tests: runs the off-loop LLM lookup over the catalog and returns
 * only ids that really exist (hallucinated ids dropped), an empty-catalog message,
 * and a no-match message — never argument schemas, and never throwing.
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { TurnCtx } from '../harness/hooks.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import { createSearchToolsTool } from './search-tools.js';
import { DrizzleToolCatalogStore } from './tool-catalog-store.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'o1' };

function selectTurn(toolIds: readonly string[]): FakeTurn {
  return { toolCalls: [{ name: 'select_tools', args: { toolIds } }] };
}

describe('search_tools', () => {
  let db: Database;
  let close: () => Promise<void>;
  let catalog: DrizzleToolCatalogStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    catalog = new DrizzleToolCatalogStore(db);
    await catalog.upsert([
      {
        toolId: 'mcp__stocks__get_quote',
        source: 'mcp',
        serverRef: 'stocks',
        toolName: 'get_quote',
        description: 'Get a realtime stock quote.',
      },
    ]);
  });
  afterEach(async () => {
    await close();
  });

  it('returns matching catalog ids and drops hallucinated ones', async () => {
    const gateway = new FakeLlmGateway([selectTurn(['mcp__stocks__get_quote', 'made__up__id'])]);
    const tool = createSearchToolsTool({ catalog, gateway, model: 'm', logger: silentLogger });
    const result = await tool.run({ intent: 'stock price' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('mcp__stocks__get_quote');
    expect(result.content).not.toContain('made__up__id');
    // No argument schema leaks into the shortlist.
    expect(result.content).not.toContain('inputSchema');
  });

  it('reports no matches when the model selects nothing usable', async () => {
    const gateway = new FakeLlmGateway([selectTurn([])]);
    const tool = createSearchToolsTool({ catalog, gateway, model: 'm', logger: silentLogger });
    const result = await tool.run({ intent: 'unrelated' }, ctx);
    expect(result.content).toContain('No matching tools');
  });

  it('reports an empty catalog', async () => {
    await catalog.deleteNotIn([]);
    const gateway = new FakeLlmGateway([selectTurn([])]);
    const tool = createSearchToolsTool({ catalog, gateway, model: 'm', logger: silentLogger });
    const result = await tool.run({ intent: 'anything' }, ctx);
    expect(result.content).toContain('No tools are available');
  });

  it('errors clearly when intent is missing', async () => {
    const gateway = new FakeLlmGateway([selectTurn([])]);
    const tool = createSearchToolsTool({ catalog, gateway, model: 'm', logger: silentLogger });
    const result = await tool.run({}, ctx);
    expect(result.isError).toBe(true);
  });
});
