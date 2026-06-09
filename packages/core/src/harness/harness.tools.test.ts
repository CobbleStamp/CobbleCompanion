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
import type { LlmGateway, StreamResult, ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import type { AppendOptions, MemoryStore, TranscriptEntry } from '../memory/store.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/tool.js';
import { Harness } from './harness.js';
import { type Block, isBlock, type ToolCall as HookToolCall, type TurnCtx } from './hooks.js';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

const companion: CompanionDto = {
  id: 'c1',
  name: 'Cobble',
  form: 'fox',
  temperament: 'curious',
  evolvedPersona: null,
  userPersona: null,
  proactivityDial: 'gentle',
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
      options?: AppendOptions,
    ): Promise<MessageDto> {
      const message: MessageDto = {
        id: `m-${appended.length + 1}`,
        companionId,
        role,
        content,
        kind: options?.kind ?? 'message',
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        sourceId: options?.sourceId ?? null,
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

/** Records every debit so a test can assert what a turn billed (or didn't). */
class RecordingQuota implements VitalityStore {
  readonly recorded: number[] = [];
  async getBalance(): Promise<number> {
    return 1_000_000;
  }
  async spend(_companionId: string, tokens: number): Promise<void> {
    this.recorded.push(tokens);
  }
  async add(): Promise<void> {}
  async isEmpty(): Promise<boolean> {
    return false;
  }
}

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

  it('exits with a partial when the token budget is exhausted (second dead-loop guard)', async () => {
    const tool = recordingTool('web_fetch', false, 'more');
    // Every turn requests the tool again; the iteration ceiling is generous, so
    // only the token budget can stop the loop. The fake meters real tokens, so the
    // first turn's usage already exceeds this tiny budget → the next iteration's
    // exhausted() check trips on tokens, not iterations.
    const gateway = new FakeLlmGateway([{ chunks: ['loop'], toolCalls: [call('web_fetch')] }]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      maxToolIterations: 100,
      turnTokenBudget: 1,
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    // The first turn ran (budget was still zero at iteration 0); the second
    // iteration saw the spent tokens exceed the budget and exited — well short of
    // the 100-iteration ceiling, proving the token guard, not the count, stopped it.
    expect(tool.calls).toHaveLength(1);
    const done = events.find((e) => e.type === 'done');
    // Carries the last spoken text as the partial (not the bare fallback).
    expect(done && done.type === 'done' && done.message.content).toBe('loop');
  });

  it('exits immediately with the partial fallback when the budget is zero', async () => {
    // A zero budget trips exhausted() on the very first iteration (0 >= 0), before
    // any model turn — there is no last text yet, so the partial fallback stands in.
    const gateway = new FakeLlmGateway([{ chunks: ['unused'], toolCalls: [call('web_fetch')] }]);
    const tool = recordingTool('web_fetch', false, 'x');
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      turnTokenBudget: 0,
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    expect(gateway.calls).toHaveLength(0); // never reached the model
    expect(tool.calls).toEqual([]);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toContain('ran out of room');
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

  it('records a tool_step row + emits a tool_step event for a read-only call', async () => {
    const tool = recordingTool('web_fetch', false, 'PAGE');
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('web_fetch', { url: 'https://x.dev' })] },
      { chunks: ['done'] },
    ]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([tool]),
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    const stepEvent = events.find((e) => e.type === 'tool_step');
    expect(stepEvent && stepEvent.type === 'tool_step' && stepEvent.step.kind).toBe('tool_step');
    expect(stepEvent && stepEvent.type === 'tool_step' && stepEvent.step.metadata?.toolName).toBe(
      'web_fetch',
    );
    // The step is a persisted transcript row (so it survives reload), distinct
    // from the assistant answer.
    const persisted = mem.appended.find((m) => m.kind === 'tool_step');
    expect(persisted?.content).toBe('Used web_fetch.');
  });

  it('records no tool_step for a failed call (would misreport failure as success)', async () => {
    // The tool throws → dispatch returns an isError result. The model still sees
    // the error fed back, but the UI-only "Used …" step must not appear, or a
    // failed look-up would read as a successful one in the transcript.
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
      { toolCalls: [call('web_fetch', { url: 'https://x.dev' })] },
      { chunks: ['recovered'] },
    ]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([throwing]),
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    expect(events.some((e) => e.type === 'tool_step')).toBe(false);
    expect(mem.appended.some((m) => m.kind === 'tool_step')).toBe(false);
    // The error still reached the model as a tool message (failures are data).
    expect(
      gateway.calls[1]!.messages.some((m) => m.role === 'tool' && m.content.includes('boom')),
    ).toBe(true);
  });

  it('records no tool_step for an unknown tool (dispatch flags it isError)', async () => {
    // An unrecognised tool name is also an isError result — no success row.
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('nope', { url: 'https://x.dev' })] },
      { chunks: ['ok'] },
    ]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([]),
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    expect(events.some((e) => e.type === 'tool_step')).toBe(false);
    expect(mem.appended.some((m) => m.kind === 'tool_step')).toBe(false);
  });

  it('persists grounding citations onto the assistant message', async () => {
    const citation = {
      sourceId: 's1',
      sourceTitle: 'Peru book',
      chapterTitle: '4',
      topicTitle: 'Sacred Valley',
      paraStart: 1,
      paraEnd: 3,
      pageStart: null,
      pageEnd: null,
    };
    const gateway = new FakeLlmGateway([{ chunks: ['Grounded answer'] }]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      retrieveContext: async () => ({
        blocks: [{ role: 'system', content: 'passage', provenance: [citation] }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      logger: silentLogger,
    });

    await collect(harness.runTurn({ companion, userContent: 'ask', ownerId: 'u1' }));

    const answer = mem.appended.find(
      (m) => m.role === 'assistant' && m.content === 'Grounded answer',
    );
    expect(answer?.metadata?.citations).toEqual([citation]);
  });

  it('persists a proposal row when an effectful call is held', async () => {
    const tool = recordingTool('ingest_source', true, 'ingested');
    const proposal: ProposalDto = {
      id: 'p1',
      toolName: 'ingest_source',
      summary: 'Remember https://x.dev',
      status: 'pending',
      createdAt: new Date('2026-01-02').toISOString(),
    };
    const gate = async (c: HookToolCall, _ctx: TurnCtx): Promise<HookToolCall | Block> =>
      'name' in c && c.name === 'ingest_source'
        ? { blocked: true, reason: 'needs approval', proposal }
        : c;
    const gateway = new FakeLlmGateway([
      { chunks: ['One moment. '], toolCalls: [call('ingest_source', { url: 'https://x.dev' })] },
    ]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([tool]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    await collect(harness.runTurn({ companion, userContent: 'save it', ownerId: 'u1' }));

    // The propose→approve exchange is recorded so it survives a reload.
    const row = mem.appended.find((m) => m.kind === 'proposal');
    expect(row?.content).toBe('Remember https://x.dev');
    expect(row?.metadata?.proposalId).toBe('p1');
  });

  it('continueAfterApproval narrates the outcome without persisting a user turn', async () => {
    const gateway = new FakeLlmGateway([{ chunks: ['Saved — here are the highlights…'] }]);
    const mem = memory();
    const harness = new Harness({ gateway, memory: mem, model: 'm', logger: silentLogger });

    const events = await collect(
      harness.continueAfterApproval({
        companion,
        ownerId: 'u1',
        outcome: 'Read https://x.dev into long-term memory.',
      }),
    );

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe(
      'Saved — here are the highlights…',
    );
    // The approval is the ENTRY: no user message is appended.
    expect(mem.appended.some((m) => m.role === 'user')).toBe(false);
    // The model is told the action completed, so it won't re-propose it.
    const modelCall = gateway.calls[0]!;
    expect(
      modelCall.messages.some(
        (m) => m.role === 'user' && m.content.includes('Read https://x.dev into long-term memory.'),
      ),
    ).toBe(true);
  });

  it('still emits a terminal done when the proposal row fails to persist', async () => {
    const proposal: ProposalDto = {
      id: 'p1',
      toolName: 'ingest_source',
      summary: 'Remember https://x.dev',
      status: 'pending',
      createdAt: new Date('2026-01-02').toISOString(),
    };
    const gate = async (c: HookToolCall): Promise<HookToolCall | Block> =>
      'name' in c && c.name === 'ingest_source'
        ? { blocked: true, reason: 'needs approval', proposal }
        : c;
    // The model emits the tool call with NO spoken pre-amble, and persisting the
    // `proposal` row fails — so neither a pre-amble nor a proposal row lands. The
    // turn must still terminate with a `done` (a fallback row), never silently.
    const mem = memory();
    const base = mem.appendMessage;
    mem.appendMessage = async (cid, role, content, options) => {
      if (options?.kind === 'proposal') throw new Error('db down');
      return base(cid, role, content, options);
    };
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('ingest_source', { url: 'https://x.dev' })] },
    ]);
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([recordingTool('ingest_source', true, 'x')]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    const events = await collect(
      harness.runTurn({ companion, userContent: 'save it', ownerId: 'u1' }),
    );

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('Remember https://x.dev');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('surfaces error when even the fallback row cannot persist (never ends silently)', async () => {
    const proposal: ProposalDto = {
      id: 'p1',
      toolName: 'ingest_source',
      summary: 'Remember https://x.dev',
      status: 'pending',
      createdAt: new Date('2026-01-02').toISOString(),
    };
    const gate = async (c: HookToolCall): Promise<HookToolCall | Block> =>
      'name' in c && c.name === 'ingest_source'
        ? { blocked: true, reason: 'needs approval', proposal }
        : c;
    // Every assistant write fails — the proposal row AND the terminal fallback;
    // only the entry user turn persists. The turn ends with `error`, not silence.
    const mem = memory();
    const base = mem.appendMessage;
    mem.appendMessage = async (cid, role, content, options) => {
      if (role === 'assistant') throw new Error('db down');
      return base(cid, role, content, options);
    };
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('ingest_source', { url: 'https://x.dev' })] },
    ]);
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([recordingTool('ingest_source', true, 'x')]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    const events = await collect(
      harness.runTurn({ companion, userContent: 'save it', ownerId: 'u1' }),
    );

    expect(events.some((e) => e.type === 'proposal')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('re-applies the gate when an approved continuation itself proposes a new effectful call', async () => {
    // Approving an action mid-continuation can itself produce a new proposal —
    // the gate re-applies (architecture.md §4.4). The resumed loop turns once,
    // the model proposes another effectful call, and we block + exit again.
    const tool = recordingTool('ingest_source', true, 'ingested');
    const proposal: ProposalDto = {
      id: 'p2',
      toolName: 'ingest_source',
      summary: 'Remember https://second.dev',
      status: 'pending',
      createdAt: new Date('2026-01-02').toISOString(),
    };
    const gate = async (c: HookToolCall, _ctx: TurnCtx): Promise<HookToolCall | Block> =>
      'name' in c && c.name === 'ingest_source'
        ? { blocked: true, reason: 'needs approval', proposal }
        : c;
    // The resumed turn proposes a second effectful action.
    const gateway = new FakeLlmGateway([
      {
        chunks: ['Saved the first. Now the next one. '],
        toolCalls: [call('ingest_source', { url: 'https://second.dev' })],
      },
    ]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([tool]),
      beforeToolCall: gate,
      logger: silentLogger,
    });

    const events = await collect(
      harness.continueAfterApproval({
        companion,
        ownerId: 'u1',
        outcome: 'Read https://first.dev into long-term memory.',
      }),
    );

    expect(tool.calls).toEqual([]); // the new effectful call is held, not run
    const proposalEvent = events.find((e) => e.type === 'proposal');
    expect(proposalEvent && proposalEvent.type === 'proposal' && proposalEvent.proposal).toEqual(
      proposal,
    );
    // A second proposal row was persisted so it survives reload.
    const row = mem.appended.find((m) => m.kind === 'proposal');
    expect(row?.metadata?.proposalId).toBe('p2');
    // The loop exited blocked again — no second model turn.
    expect(gateway.calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('bills the consumed tokens when the consumer aborts a tool run mid-stream', async () => {
    // (a) The caller breaks out of the generator (a client disconnect that
    // `.return()`s it) before the turn finishes — the abnormal-exit path must
    // still debit the tokens already streamed, never free output
    // (billing-crash-compensation).
    const tool = recordingTool('web_fetch', false, 'more');
    const gateway = new FakeLlmGateway([
      { chunks: ['Look', 'ing', ' it up'], toolCalls: [call('web_fetch')] },
    ]);
    const quota = new RecordingQuota();
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      quota,
      logger: silentLogger,
    });

    for await (const event of harness.runTurn({
      companion,
      userContent: 'go',
      ownerId: 'u1',
    })) {
      if (event.type === 'token') break; // disconnect mid-stream
    }

    // The consumed tokens were metered and debited, not silently dropped.
    expect(quota.recorded).toHaveLength(1);
    expect(quota.recorded[0]).toBeGreaterThan(0);
  });

  it('frees only our-fault tokens when a provider fault throws mid-loop', async () => {
    // (b) A provider/infra fault throws mid-stream. Per the billing rule, the
    // broken turn's tokens stay out of the accumulator, so nothing is billed —
    // free ONLY for our software/infra faults.
    const faulting: LlmGateway = {
      async *stream(): AsyncGenerator<string, StreamResult, void> {
        yield 'partial';
        throw new Error('network drop');
      },
    };
    const quota = new RecordingQuota();
    const harness = new Harness({
      gateway: faulting,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([recordingTool('web_fetch', false, 'x')]),
      quota,
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    expect(events.at(-1)?.type).toBe('error');
    // Our fault — nothing debited for the broken turn.
    expect(quota.recorded).toEqual([]);
  });

  it('runs two read-only tools in one turn: both results fed back, both steps recorded', async () => {
    const tool = recordingTool('web_fetch', false, 'PAGE');
    // One turn requests the SAME read-only tool twice (distinct call ids), then
    // the next turn answers.
    const gateway = new FakeLlmGateway([
      {
        toolCalls: [
          { id: 'call-a', name: 'web_fetch', args: { url: 'https://a.dev' } },
          { id: 'call-b', name: 'web_fetch', args: { url: 'https://b.dev' } },
        ],
      },
      { chunks: ['done'] },
    ]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([tool]),
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    // Both calls ran.
    expect(tool.calls).toEqual([{ url: 'https://a.dev' }, { url: 'https://b.dev' }]);
    // Both results were appended to the model's context with their own ids.
    const secondCall = gateway.calls[1]!;
    const toolMessages = secondCall.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(toolMessages.every((m) => m.content === 'PAGE')).toBe(true);
    // Both tool_step rows were emitted and persisted.
    const stepEvents = events.filter((e) => e.type === 'tool_step');
    expect(stepEvents).toHaveLength(2);
    expect(mem.appended.filter((m) => m.kind === 'tool_step')).toHaveLength(2);
  });

  it('exits before any provider call when maxToolIterations is zero', async () => {
    // A zero iteration ceiling trips exhausted() on the very first iteration
    // (0 >= 0), before any model turn — the partial fallback stands in.
    const tool = recordingTool('web_fetch', false, 'x');
    const gateway = new FakeLlmGateway([{ chunks: ['unused'], toolCalls: [call('web_fetch')] }]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([tool]),
      maxToolIterations: 0,
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    expect(gateway.calls).toHaveLength(0); // never reached the model
    expect(tool.calls).toEqual([]);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toContain('ran out of room');
  });

  // Guards the import surface used above (avoids an unused-import lint).
  it('exposes isBlock for callers', () => {
    expect(isBlock({ blocked: true, reason: 'x' })).toBe(true);
    expect(isBlock({ name: 'a', args: {} })).toBe(false);
  });
});

describe('Harness per-companion registry (Phase 9 — tool acquisition)', () => {
  it('advertises and dispatches tools from the resolved per-companion registry', async () => {
    // No static tools; the per-companion resolver supplies an acquired (MCP) tool.
    const acquired = recordingTool('mcp__stocks__get_quote', false, 'AAPL $190');
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('mcp__stocks__get_quote', { symbol: 'AAPL' })] },
      { chunks: ['It is $190.'] },
    ]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      resolveRegistry: async () => new ToolRegistry([acquired]),
      logger: silentLogger,
    });

    const events = await collect(
      harness.runTurn({ companion, userContent: 'price?', ownerId: 'u1' }),
    );

    expect(acquired.calls).toEqual([{ symbol: 'AAPL' }]);
    // The resolved tool was advertised to the provider this turn.
    expect(gateway.calls[0]!.tools?.map((t) => t.name)).toEqual(['mcp__stocks__get_quote']);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('It is $190.');
  });

  it('degrades to the static registry when the resolver throws (acquisition never breaks a turn)', async () => {
    const staticTool = recordingTool('web_fetch', false, 'PAGE');
    const gateway = new FakeLlmGateway([
      { toolCalls: [call('web_fetch', { url: 'https://x.dev' })] },
      { chunks: ['done'] },
    ]);
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([staticTool]),
      resolveRegistry: async () => {
        throw new Error('registry resolve failed');
      },
      logger: silentLogger,
    });

    const events = await collect(harness.runTurn({ companion, userContent: 'go', ownerId: 'u1' }));

    // The turn still ran on the static registry.
    expect(staticTool.calls).toEqual([{ url: 'https://x.dev' }]);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
