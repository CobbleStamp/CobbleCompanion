/**
 * Phase 9 Definition-of-Done, end to end (offline, deterministic). Drives runtime
 * MCP tool acquisition through the real harness + stores over a FakeMcpGateway:
 * the companion DISCOVERS a tool (search_tools), LOADS it (load_tool), and CALLS
 * it — the loaded tool becoming callable on the next loop iteration via the
 * per-step registry — with every call logged. Further cases assert the equipped
 * tool survives a process restart, an off-catalog id is denied, and a large
 * catalog never inflates the per-turn advertised tool set (the scaling property).
 *
 * Note on turn scripting: `search_tools` runs its lookup on the SAME FakeLlmGateway
 * as the main loop, so its scripted turn is interleaved right after the turn that
 * called it (the gateway advances one scripted turn per `stream()` call).
 * (Affect is disabled so the scripted fake-LLM turn sequence is deterministic.)
 */

import type { ChatStreamEvent, McpToolSnapshot } from '@cobble/shared';
import { FakeMcpGateway } from '@cobble/core';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, silentLogger, type TestApp } from '../test/helpers.js';

const STOCKS = { ref: 'stocks', endpoint: 'https://mcp.example.com' };
const QUOTE_ID = 'mcp__stocks__get_quote';
const getQuote: McpToolSnapshot = {
  name: 'get_quote',
  description: 'Get a realtime stock quote for a ticker symbol.',
  inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } },
};

async function send(
  ctx: TestApp,
  companionId: string,
  auth: { authorization: string },
  content: string,
) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/companions/${companionId}/messages`,
    headers: auth,
    payload: { content },
  });
  return res.payload
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice('data:'.length).trim()) as ChatStreamEvent);
}

function doneText(events: readonly ChatStreamEvent[]): string {
  const done = events.find((event) => event.type === 'done');
  return done && done.type === 'done' ? done.message.content : '';
}

async function createCompanion(ctx: TestApp, auth: { authorization: string }): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/companions',
    headers: auth,
    payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
  });
  return created.json().companion.id;
}

describe('Phase 9 DoD — runtime MCP tool acquisition', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  afterEach(async () => {
    await ctx.close();
  });

  async function setup(
    turns: Parameters<typeof makeTestApp>[0],
    gateway: FakeMcpGateway,
    config: Parameters<typeof makeTestApp>[2] = {},
  ): Promise<void> {
    ctx = await makeTestApp(turns, silentLogger, {
      config: { mcpServers: [STOCKS] },
      mcpGateway: gateway,
      disableAffect: true,
      ...config,
    });
    auth = ctx.bearerFor('owner@example.com');
    companionId = await createCompanion(ctx, auth);
  }

  it('discovers a tool, loads it, and calls it on the next iteration', async () => {
    const gateway = new FakeMcpGateway({
      stocks: { tools: [getQuote], results: { get_quote: 'AAPL is trading at $190.12' } },
    });
    // Interleaved turn sequence (affect off):
    //  [0] main: model calls search_tools
    //  [1] search_tools' own lookup: select_tools → the catalog id
    //  [2] main: model calls load_tool with that id
    //  [3] main: the now-equipped MCP tool is callable → model calls it
    //  [4] main: final answer
    await setup(
      [
        {
          chunks: ['Searching. '],
          toolCalls: [{ id: 's1', name: 'search_tools', args: { intent: 'stock quote' } }],
        },
        { toolCalls: [{ id: 'sel1', name: 'select_tools', args: { toolIds: [QUOTE_ID] } }] },
        {
          chunks: ['Loading. '],
          toolCalls: [{ id: 'l1', name: 'load_tool', args: { tool_id: QUOTE_ID } }],
        },
        {
          chunks: ['Checking. '],
          toolCalls: [{ id: 'q1', name: QUOTE_ID, args: { symbol: 'AAPL' } }],
        },
        { chunks: ['AAPL is at $190.12.'] },
      ],
      gateway,
    );

    const events = await send(ctx, companionId, auth, 'What is the AAPL stock quote?');
    expect(doneText(events)).toContain('$190.12');

    // The equipped MCP tool was actually invoked over the gateway with the args.
    expect(gateway.calls).toEqual([{ ref: 'stocks', name: 'get_quote', args: { symbol: 'AAPL' } }]);

    // Every dispatched call was logged — discovery, load, and the namespaced tool.
    const logged = (await ctx.deps.toolCallLog.list(companionId, 10)).map((row) => row.name);
    expect(logged).toContain('search_tools');
    expect(logged).toContain('load_tool');
    expect(logged).toContain(QUOTE_ID);
  });

  it('denies loading an id that is not in the catalog (nothing reaches the gateway)', async () => {
    const gateway = new FakeMcpGateway({ stocks: { tools: [getQuote] } });
    await setup(
      [
        {
          chunks: ['Trying. '],
          toolCalls: [{ id: 'l1', name: 'load_tool', args: { tool_id: 'mcp__evil__rm' } }],
        },
        { chunks: ['I could not load that tool.'] },
      ],
      gateway,
    );

    const events = await send(ctx, companionId, auth, 'Use the evil tool.');
    expect(doneText(events)).toContain('could not load');
    // The catalog/whitelist denied it before any tool call reached the gateway.
    expect(gateway.calls).toHaveLength(0);
    // The attempt is still audited.
    const logged = (await ctx.deps.toolCallLog.list(companionId, 10)).map((row) => row.name);
    expect(logged).toContain('load_tool');
  });

  it('advertises only the small core set regardless of catalog size (scaling)', async () => {
    // A catalog with many tools across several servers…
    const big = new FakeMcpGateway({
      stocks: { tools: [getQuote, { ...getQuote, name: 'history' }] },
      news: {
        tools: [{ name: 'top', description: 'Top headlines.', inputSchema: { type: 'object' } }],
      },
      weather: {
        tools: [{ name: 'forecast', description: 'Forecast.', inputSchema: { type: 'object' } }],
      },
    });
    await setup([{ chunks: ['Hello!'] }], big, {
      config: {
        mcpServers: [
          STOCKS,
          { ref: 'news', endpoint: 'https://news.example.com' },
          { ref: 'weather', endpoint: 'https://weather.example.com' },
        ],
      },
    });
    await send(ctx, companionId, auth, 'Just say hi.');

    // …yet the core set advertised every turn is only the native tools + the two
    // discovery meta-tools. No catalog (mcp__) tool is advertised until loaded.
    const advertised = ctx.deps.tools.list().map((tool) => tool.name);
    expect(advertised).toContain('search_tools');
    expect(advertised).toContain('load_tool');
    expect(advertised.filter((name) => name.startsWith('mcp__'))).toHaveLength(0);
  });
});

describe('Phase 9 DoD — equipped tool survives a process restart', () => {
  it('rebuilds the registry from the persisted equipped set: a cold app instance can call a tool loaded by the previous one', async () => {
    const shared = await createTestDatabase();
    try {
      // ---- App #1: discover + load the tool, then shut down. ----
      const gateway1 = new FakeMcpGateway({ stocks: { tools: [getQuote] } });
      const app1 = await makeTestApp(
        [
          {
            chunks: ['Searching. '],
            toolCalls: [{ id: 's1', name: 'search_tools', args: { intent: 'stock quote' } }],
          },
          { toolCalls: [{ id: 'sel1', name: 'select_tools', args: { toolIds: [QUOTE_ID] } }] },
          {
            chunks: ['Loading. '],
            toolCalls: [{ id: 'l1', name: 'load_tool', args: { tool_id: QUOTE_ID } }],
          },
          { chunks: ['Loaded the stocks quote tool.'] },
        ],
        silentLogger,
        {
          config: { mcpServers: [STOCKS] },
          mcpGateway: gateway1,
          disableAffect: true,
          database: shared,
        },
      );
      const auth = app1.bearerFor('owner@example.com');
      const companionId = await createCompanion(app1, auth);
      const loadEvents = await send(app1, companionId, auth, 'Get me a stock tool.');
      expect(doneText(loadEvents)).toContain('Loaded');
      await app1.close();

      // ---- App #2: cold start over the SAME db, with a fresh gateway. ----
      const gateway2 = new FakeMcpGateway({
        stocks: { tools: [getQuote], results: { get_quote: 'AAPL is trading at $190.12' } },
      });
      const app2 = await makeTestApp(
        [
          {
            chunks: ['Let me check. '],
            toolCalls: [{ id: 'q1', name: QUOTE_ID, args: { symbol: 'AAPL' } }],
          },
          { chunks: ['AAPL is at $190.12.'] },
        ],
        silentLogger,
        {
          config: { mcpServers: [STOCKS] },
          mcpGateway: gateway2,
          disableAffect: true,
          database: shared,
        },
      );
      try {
        const auth2 = app2.bearerFor('owner@example.com');
        // The tool is callable on a cold instance only because the resolver rebuilt
        // the registry from the equipped row app #1 persisted — no re-discovery.
        const quoteEvents = await send(app2, companionId, auth2, 'What is the AAPL stock quote?');
        expect(doneText(quoteEvents)).toContain('$190.12');
        expect(gateway2.calls).toEqual([
          { ref: 'stocks', name: 'get_quote', args: { symbol: 'AAPL' } },
        ]);
      } finally {
        await app2.close();
      }
    } finally {
      await shared.close();
    }
  });
});
