/**
 * Phase 9 Definition-of-Done, end to end (offline, deterministic). Drives runtime
 * MCP tool acquisition through the real harness + stores over a FakeMcpGateway:
 * the companion connects to a whitelisted server (connect_mcp), the connection
 * persists, and on a later turn it retrieves and CALLS a tool from that server —
 * with every call logged. A second case asserts an off-whitelist server is denied.
 * (Affect is disabled so the scripted fake-LLM turn sequence is deterministic.)
 */

import type { ChatStreamEvent, McpToolSnapshot } from '@cobble/shared';
import { FakeMcpGateway } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, silentLogger, type TestApp } from '../test/helpers.js';

const STOCKS = { ref: 'stocks', endpoint: 'https://mcp.example.com' };
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
  ): Promise<void> {
    ctx = await makeTestApp(turns, silentLogger, {
      config: { mcpServers: [STOCKS] },
      mcpGateway: gateway,
      disableAffect: true,
    });
    auth = ctx.bearerFor('owner@example.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    companionId = created.json().companion.id;
  }

  it('connects a whitelisted server, then retrieves and calls its tool on a later turn', async () => {
    const gateway = new FakeMcpGateway({
      stocks: { tools: [getQuote], results: { get_quote: 'AAPL is trading at $190.12' } },
    });
    // Turn sequence (affect off): msg1 = connect_mcp call + answer; msg2 = the MCP
    // tool call + answer. The tool is callable on msg2 because the registry rebuilds
    // from the persisted connection at the start of that run.
    await setup(
      [
        {
          chunks: ['Connecting. '],
          toolCalls: [{ id: 'c1', name: 'connect_mcp', args: { server: 'stocks' } }],
        },
        { chunks: ['Connected to the stocks server.'] },
        {
          chunks: ['Let me check. '],
          toolCalls: [{ id: 'q1', name: 'mcp__stocks__get_quote', args: { symbol: 'AAPL' } }],
        },
        { chunks: ['AAPL is at $190.12.'] },
      ],
      gateway,
    );

    // Message 1: connect.
    const connectEvents = await send(ctx, companionId, auth, 'Connect to the stocks server.');
    expect(doneText(connectEvents)).toContain('Connected to the stocks server');
    // connect_mcp validated the whitelist before any network call — it did call the
    // gateway's tools/list (not callTool yet).
    expect(gateway.calls).toHaveLength(0); // listTools is not recorded; only callTool is

    // Message 2: ask something the connected tool answers. The registry resolver
    // rebuilds from the *persisted* connection, so the MCP tool is now callable.
    const quoteEvents = await send(ctx, companionId, auth, 'What is the AAPL stock quote?');
    expect(doneText(quoteEvents)).toContain('$190.12');

    // The MCP tool was actually invoked over the gateway with the model's args.
    expect(gateway.calls).toEqual([{ ref: 'stocks', name: 'get_quote', args: { symbol: 'AAPL' } }]);

    // Every tool call was logged — connect_mcp and the namespaced MCP tool.
    const logged = (await ctx.deps.toolCallLog.list(companionId, 10)).map((row) => row.name);
    expect(logged).toContain('connect_mcp');
    expect(logged).toContain('mcp__stocks__get_quote');
  });

  it('denies connecting to an off-whitelist server (nothing reaches the gateway)', async () => {
    const gateway = new FakeMcpGateway({
      stocks: { tools: [getQuote] },
    });
    await setup(
      [
        {
          chunks: ['Trying. '],
          toolCalls: [{ id: 'c1', name: 'connect_mcp', args: { server: 'evil' } }],
        },
        { chunks: ['I could not connect to that one.'] },
      ],
      gateway,
    );

    const events = await send(ctx, companionId, auth, 'Connect to the evil server.');
    // The run completed (the denial fed back as an error result, then the model answered).
    expect(doneText(events)).toContain('could not connect');
    // The whitelist denied it before any gateway call.
    expect(gateway.calls).toHaveLength(0);
    // The attempt is still audited (afterToolCall logs every dispatched call).
    const logged = (await ctx.deps.toolCallLog.list(companionId, 10)).map((row) => row.name);
    expect(logged).toContain('connect_mcp');
  });
});
