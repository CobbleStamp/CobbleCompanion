/**
 * Phase 10 Definition-of-Done, end to end (offline, deterministic). Drives runtime
 * CLI tool acquisition through the real harness + stores, reading tool definitions
 * from a temp `CLI_TOOLS_PATH` fixture with the real FileSystemCliToolStore, and
 * executing through a FakeCommandSandbox (deterministic + cross-platform — the real
 * subprocess sandbox is covered separately). The companion DISCOVERS a CLI tool
 * (search_tools), LOADS it (load_tool), and CALLS it — callable on the next loop
 * iteration via the per-step registry — with every call logged. Further cases
 * assert the equipped CLI tool survives a process restart, an off-catalog id is
 * denied before any subprocess, and a large catalog never inflates the per-turn
 * advertised tool set (the scaling property).
 *
 * Proactive loading of a recalled routine's CLI tools is the source-agnostic
 * load-advisor (covered by its own unit tests) — a cli__ catalog id flows through
 * it identically to an mcp__ id, so it is not re-proven here.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatStreamEvent } from '@cobble/shared';
import { type CommandResult, FakeCommandSandbox } from '@cobble/core';
import { createTestDatabase } from '@cobble/db/testing';
import { FileSystemCliToolStore } from '../cli/fs-tool-store.js';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, silentLogger, type TestApp } from '../test/helpers.js';

const QUOTE_ID = 'cli__quote';

/** Write a `quote` CLI tool folder under a fresh temp dir; return the dir + cleanup. */
async function makeToolsDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const toolDir = join(dir, 'quote');
  await mkdir(toolDir, { recursive: true });
  await writeFile(
    join(toolDir, 'TOOL.json'),
    JSON.stringify({
      binary: 'quote-cli',
      description: 'Get a realtime stock quote for a ticker symbol.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
        additionalProperties: false,
      },
      argv: ['get', '{symbol}'],
    }),
    'utf8',
  );
  await writeFile(join(toolDir, 'TOOL.md'), '# quote\nFetch a stock quote for a ticker.', 'utf8');
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A sandbox that "quotes" AAPL deterministically when the symbol reaches argv. */
const quoteSandbox = (): FakeCommandSandbox =>
  new FakeCommandSandbox(
    (req): CommandResult => ({
      output: req.argv.includes('AAPL') ? 'AAPL is trading at $190.12' : 'unknown symbol',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    }),
  );

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

describe('Phase 10 DoD — runtime CLI tool acquisition', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;
  let cleanupDir: () => Promise<void>;

  afterEach(async () => {
    await ctx.close();
    await cleanupDir();
  });

  async function setup(
    turns: Parameters<typeof makeTestApp>[0],
    sandbox: FakeCommandSandbox,
    extraConfig: Record<string, unknown> = {},
  ): Promise<void> {
    const { dir, cleanup } = await makeToolsDir();
    cleanupDir = cleanup;
    ctx = await makeTestApp(turns, silentLogger, {
      config: { cliToolsPath: dir, ...extraConfig },
      cliToolStore: new FileSystemCliToolStore(dir, silentLogger),
      cliSandbox: sandbox,
      disableAffect: true,
    });
    auth = ctx.bearerFor('owner@example.com');
    companionId = await createCompanion(ctx, auth);
  }

  it('discovers a CLI tool, loads it, and calls it on the next iteration', async () => {
    const sandbox = quoteSandbox();
    // Interleaved turn sequence (affect off):
    //  [0] main: model calls search_tools
    //  [1] search_tools' own lookup: select_tools → the catalog id
    //  [2] main: model calls load_tool with that id
    //  [3] main: the now-equipped CLI tool is callable → model calls it
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
      sandbox,
    );

    const events = await send(ctx, companionId, auth, 'What is the AAPL stock quote?');
    expect(doneText(events)).toContain('$190.12');

    // The equipped CLI tool actually ran in the sandbox with the rendered argv.
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]).toMatchObject({ binary: 'quote-cli', argv: ['get', 'AAPL'] });

    // Every dispatched call was logged — discovery, load, and the namespaced tool.
    const logged = (await ctx.deps.toolCallLog.list(companionId, 10)).map((row) => row.name);
    expect(logged).toContain('search_tools');
    expect(logged).toContain('load_tool');
    expect(logged).toContain(QUOTE_ID);
  });

  it('denies loading an id that is not in the catalog (nothing reaches the sandbox)', async () => {
    const sandbox = quoteSandbox();
    await setup(
      [
        {
          chunks: ['Trying. '],
          toolCalls: [{ id: 'l1', name: 'load_tool', args: { tool_id: 'cli__evil' } }],
        },
        { chunks: ['I could not load that tool.'] },
      ],
      sandbox,
    );

    const events = await send(ctx, companionId, auth, 'Use the evil tool.');
    expect(doneText(events)).toContain('could not load');
    // The catalog denied it before any command ran.
    expect(sandbox.calls).toHaveLength(0);
    // The attempt is still audited.
    const logged = (await ctx.deps.toolCallLog.list(companionId, 10)).map((row) => row.name);
    expect(logged).toContain('load_tool');
  });

  it('advertises only the small core set regardless of catalog size (scaling)', async () => {
    const sandbox = quoteSandbox();
    await setup([{ chunks: ['Hello!'] }], sandbox);
    await send(ctx, companionId, auth, 'Just say hi.');

    // The core set advertised every turn is only the native tools + the two
    // discovery meta-tools. No catalog (cli__) tool is advertised until loaded.
    const advertised = ctx.deps.tools.list().map((tool) => tool.name);
    expect(advertised).toContain('search_tools');
    expect(advertised).toContain('load_tool');
    expect(advertised.filter((name) => name.startsWith('cli__'))).toHaveLength(0);
  });
});

describe('Phase 10 DoD — equipped CLI tool survives a process restart', () => {
  it('rebuilds the registry from the persisted equipped set: a cold app calls a tool the previous one loaded', async () => {
    const shared = await createTestDatabase();
    const { dir, cleanup } = await makeToolsDir();
    try {
      // ---- App #1: discover + load the tool, then shut down. ----
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
          { chunks: ['Loaded the quote tool.'] },
        ],
        silentLogger,
        {
          config: { cliToolsPath: dir },
          cliToolStore: new FileSystemCliToolStore(dir, silentLogger),
          cliSandbox: quoteSandbox(),
          disableAffect: true,
          database: shared,
        },
      );
      const auth = app1.bearerFor('owner@example.com');
      const companionId = await createCompanion(app1, auth);
      const loadEvents = await send(app1, companionId, auth, 'Get me a quote tool.');
      expect(doneText(loadEvents)).toContain('Loaded');
      await app1.close();

      // ---- App #2: cold start over the SAME db + tool dir, fresh sandbox. ----
      const sandbox2 = quoteSandbox();
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
          config: { cliToolsPath: dir },
          cliToolStore: new FileSystemCliToolStore(dir, silentLogger),
          cliSandbox: sandbox2,
          disableAffect: true,
          database: shared,
        },
      );
      try {
        const auth2 = app2.bearerFor('owner@example.com');
        // Callable on a cold instance only because the resolver rebuilt the registry
        // from the equipped row app #1 persisted — no re-discovery.
        const quoteEvents = await send(app2, companionId, auth2, 'What is the AAPL stock quote?');
        expect(doneText(quoteEvents)).toContain('$190.12');
        expect(sandbox2.calls).toHaveLength(1);
        expect(sandbox2.calls[0]).toMatchObject({ binary: 'quote-cli', argv: ['get', 'AAPL'] });
      } finally {
        await app2.close();
      }
    } finally {
      await shared.close();
      await cleanup();
    }
  });
});
