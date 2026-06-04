/**
 * The harness inner loop (P3): tool iteration, the propose→approve block-and-exit,
 * the dead-loop budget guard, and failures-as-data when a tool throws.
 */

import type {
  ChatStreamEvent,
  CompanionDto,
  MessageDto,
  MessageRole,
  ProposalDto,
} from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import type { ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { MemoryStore, TranscriptEntry } from '../memory/store.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/tool.js';
import { Harness } from './harness.js';
import { type Block, isBlock, type ToolCall as HookToolCall, type TurnCtx } from './hooks.js';

const silentLogger: Logger = { error: () => undefined, info: () => undefined };

const companion: CompanionDto = {
  id: 'c1',
  name: 'Cobble',
  form: 'fox',
  temperament: 'curious',
  evolvedPersona: null,
  createdAt: new Date('2026-01-01').toISOString(),
};

/**
 * A no-DB fake transcript: records appended turns so tests assert what was
 * persisted, and recalls nothing (the loop, not recall, is under test here).
 */
function memory(): MemoryStore & { appended: MessageDto[] } {
  const appended: MessageDto[] = [];
  return {
    appended,
    async appendMessage(
      companionId: string,
      role: MessageRole,
      content: string,
    ): Promise<MessageDto> {
      const message: MessageDto = {
        id: `m-${appended.length + 1}`,
        companionId,
        role,
        content,
        sourceId: null,
        createdAt: new Date('2026-01-02').toISOString(),
      };
      appended.push(message);
      return message;
    },
    async getRecentMessages(): Promise<readonly MessageDto[]> {
      return [];
    },
    async getMessagesSince(): Promise<readonly TranscriptEntry[]> {
      return [];
    },
    async countMessages(): Promise<number> {
      return appended.length;
    },
  };
}

/** A tool that records its calls and returns a fixed string. */
function recordingTool(
  name: string,
  effectful: boolean,
  reply: string,
): Tool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    effectful,
    async run(args) {
      calls.push(args);
      return { name, content: reply };
    },
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `id-${name}`,
  name,
  args,
});

describe('Harness inner loop (P3 tools)', () => {
  it('runs a read-only tool, feeds the result back, and answers on the next turn', async () => {
    const tool = recordingTool('web_fetch', false, 'PAGE TEXT');
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('web_fetch', { url: 'https://x.dev' })] },
      { chunks: ['Based on the page, '] },
      // (only two turns are needed; the second has no tool calls → exit)
    ] satisfies FakeTurn[]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      logger: silentLogger,
    });

    const events = await collect(
      harness.runTurn({ companion, userContent: 'read it', ownerId: 'u1' }),
    );

    expect(tool.calls).toEqual([{ url: 'https://x.dev' }]);
    expect(events.filter((e) => e.type === 'token')).toHaveLength(1);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('Based on the page, ');
    // The provider saw the tool result fed back as a tool-role message.
    const secondCall = gateway.calls[1]!;
    expect(secondCall.messages.some((m) => m.role === 'tool' && m.content === 'PAGE TEXT')).toBe(
      true,
    );
    expect(secondCall.messages.some((m) => m.role === 'assistant' && m.toolCalls)).toBe(true);
  });

  it('blocks an effectful tool: emits a proposal, runs nothing, and exits', async () => {
    const tool = recordingTool('ingest_source', true, 'ingested');
    const proposal: ProposalDto = {
      id: 'p1',
      toolName: 'ingest_source',
      summary: 'Remember https://x.dev',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    // Gate that blocks effectful calls, attaching a (pretend-persisted) proposal.
    const gate = async (c: HookToolCall, _ctx: TurnCtx): Promise<HookToolCall | Block> =>
      tool.effectful && c.name === 'ingest_source'
        ? { blocked: true, reason: 'needs approval', proposal }
        : c;
    const gateway = new FakeLlmGateway([
      {
        chunks: ['Let me save that. '],
        toolCalls: [call('ingest_source', { url: 'https://x.dev' })],
      },
    ]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    const events = await collect(
      harness.runTurn({ companion, userContent: 'save it', ownerId: 'u1' }),
    );

    expect(tool.calls).toEqual([]); // nothing executed
    const proposalEvent = events.find((e) => e.type === 'proposal');
    expect(proposalEvent && proposalEvent.type === 'proposal' && proposalEvent.proposal).toEqual(
      proposal,
    );
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('Let me save that. ');
    expect(gateway.calls).toHaveLength(1); // exited; no second model turn
  });

  it('holds every effectful call in a turn as its own proposal (no dropped calls)', async () => {
    const tool = recordingTool('ingest_source', true, 'ingested');
    // A gate that blocks every effectful call, minting a distinct proposal per
    // call so we can assert both survive (not just the first).
    const gate = async (c: HookToolCall, _ctx: TurnCtx): Promise<HookToolCall | Block> => {
      if (!('args' in c)) return c;
      const url = (c.args as { url?: string }).url ?? '';
      const proposal: ProposalDto = {
        id: `p-${url}`,
        toolName: c.name,
        summary: `Remember ${url}`,
        status: 'pending',
        createdAt: new Date('2026-01-02').toISOString(),
      };
      return { blocked: true, reason: 'needs approval', proposal };
    };
    const gateway = new FakeLlmGateway([
      {
        chunks: ['Let me save both. '],
        toolCalls: [
          call('ingest_source', { url: 'https://a.dev' }),
          call('ingest_source', { url: 'https://b.dev' }),
        ],
      },
    ]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    const events = await collect(
      harness.runTurn({ companion, userContent: 'save both', ownerId: 'u1' }),
    );

    expect(tool.calls).toEqual([]); // still nothing executed
    const proposals = events
      .filter((e) => e.type === 'proposal')
      .map((e) => (e.type === 'proposal' ? e.proposal.summary : ''));
    // Both calls became proposals — the second is no longer silently dropped.
    expect(proposals).toEqual(['Remember https://a.dev', 'Remember https://b.dev']);
    expect(gateway.calls).toHaveLength(1); // exited once, after collecting both
  });

  it('still runs a read-only call that follows a blocked effectful call', async () => {
    const lookup = recordingTool('web_fetch', false, 'PAGE TEXT');
    const remember = recordingTool('ingest_source', true, 'ingested');
    const proposal: ProposalDto = {
      id: 'p1',
      toolName: 'ingest_source',
      summary: 'Remember https://a.dev',
      status: 'pending',
      createdAt: new Date('2026-01-02').toISOString(),
    };
    const gate = async (c: HookToolCall, _ctx: TurnCtx): Promise<HookToolCall | Block> =>
      'name' in c && c.name === 'ingest_source'
        ? { blocked: true, reason: 'needs approval', proposal }
        : c;
    // The effectful call comes FIRST; the read-only one must still run.
    const gateway = new FakeLlmGateway([
      {
        chunks: ['Working on it. '],
        toolCalls: [
          call('ingest_source', { url: 'https://a.dev' }),
          call('web_fetch', { url: 'https://b.dev' }),
        ],
      },
    ]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([lookup, remember]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    expect(remember.calls).toEqual([]); // effectful held, not run
    expect(lookup.calls).toEqual([{ url: 'https://b.dev' }]); // read-only ran anyway
    expect(events.some((e) => e.type === 'proposal')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('logs every tool call via afterToolCall', async () => {
    const tool = recordingTool('web_fetch', false, 'TEXT');
    const logged: string[] = [];
    const gateway = new FakeLlmGateway([{ toolCalls: [call('web_fetch')] }, { chunks: ['done'] }]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      afterToolCall: async (result) => {
        logged.push(result.name);
        return result;
      },
      logger: silentLogger,
    });
    await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));
    expect(logged).toEqual(['web_fetch']);
  });

  it('exits with a partial when the model never stops calling tools (dead-loop guard)', async () => {
    const tool = recordingTool('web_fetch', false, 'more');
    // Every turn requests the tool again — only the iteration ceiling stops it.
    const gateway = new FakeLlmGateway([{ chunks: ['loop'], toolCalls: [call('web_fetch')] }]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      maxToolIterations: 3,
      logger: silentLogger,
    });
    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));
    // 3 turns ran the tool, then the 4th iteration tripped the ceiling and exited.
    expect(tool.calls).toHaveLength(3);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('turns a thrown tool into an error result and keeps going (failures are data)', async () => {
    const throwing: Tool = {
      name: 'web_fetch',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      effectful: false,
      async run() {
        throw new Error('boom');
      },
    };
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('web_fetch')] },
      { chunks: ['recovered'] },
    ]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([throwing]),
      logger: silentLogger,
    });
    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('recovered');
    // The error result was fed back to the model as a tool message.
    const secondCall = gateway.calls[1]!;
    expect(secondCall.messages.some((m) => m.role === 'tool' && m.content.includes('boom'))).toBe(
      true,
    );
  });

  // Guards the import surface used above (avoids an unused-import lint).
  it('exposes isBlock for callers', () => {
    expect(isBlock({ blocked: true, reason: 'x' })).toBe(true);
    expect(isBlock({ name: 'a', args: {} })).toBe(false);
  });
});
