/** The approval gate + logging hook: effectful → block+enqueue, read-only → pass, log all. */

import type { ProposalDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../llm/gateway.js';
import type { Logger } from '../logging.js';
import { isBlock, type TurnCtx } from '../harness/hooks.js';
import { createApprovalGate, createLoggingAfterToolCall } from './gate.js';
import type { CreateProposalInput, ProposalRecord, ProposalStore } from './proposal-store.js';
import { ToolRegistry } from './registry.js';
import type { Tool } from './tool.js';
import type { ToolCallLog, ToolCallRecord } from './tool-call-log.js';

const ctx: TurnCtx = { companionId: 'c1', ownerId: 'u1' };
const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

function tool(name: string, effectful: boolean, summary?: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    effectful,
    ...(summary ? { proposalSummary: () => summary } : {}),
    async run() {
      return { name, content: 'ran' };
    },
  };
}

/** A proposal store that records what it was asked to create. */
function fakeProposals(): ProposalStore & { created: CreateProposalInput[] } {
  const created: CreateProposalInput[] = [];
  return {
    created,
    async create(_companionId, input): Promise<ProposalRecord> {
      created.push(input);
      return {
        id: 'p1',
        companionId: 'c1',
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        toolCallId: input.toolCallId ?? null,
        summary: input.summary,
        status: 'pending',
        leadId: input.leadId ?? null,
        createdAt: new Date('2026-01-01'),
        resolvedAt: null,
      };
    },
    async listPending() {
      return [];
    },
    async get() {
      return null;
    },
    async markResolved() {
      return null;
    },
  };
}

const aCall = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `id-${name}`,
  name,
  args,
});

describe('createApprovalGate', () => {
  it('passes a read-only call straight through (runs freely)', async () => {
    const proposals = fakeProposals();
    const gate = createApprovalGate(
      proposals,
      new ToolRegistry([tool('web_fetch', false)]),
      silentLogger,
    );
    const result = await gate(aCall('web_fetch'), ctx);
    expect(isBlock(result)).toBe(false);
    expect(proposals.created).toEqual([]);
  });

  it('blocks an effectful call, enqueuing a pending proposal with the tool summary', async () => {
    const proposals = fakeProposals();
    const gate = createApprovalGate(
      proposals,
      new ToolRegistry([tool('ingest_source', true, 'Read it into memory')]),
      silentLogger,
    );
    const result = await gate(aCall('ingest_source', { url: 'https://x.dev' }), ctx);
    expect(isBlock(result)).toBe(true);
    expect(proposals.created).toEqual([
      {
        toolName: 'ingest_source',
        toolArgs: { url: 'https://x.dev' },
        toolCallId: 'id-ingest_source',
        summary: 'Read it into memory',
      },
    ]);
    if (isBlock(result)) {
      const proposal = result.proposal as ProposalDto;
      expect(proposal.summary).toBe('Read it into memory');
      expect(proposal.status).toBe('pending');
    }
  });

  it('falls back to a generic summary when the effectful tool defines none', async () => {
    const proposals = fakeProposals();
    // No proposalSummary on the tool → the gate synthesizes `Run "<name>"`.
    const gate = createApprovalGate(
      proposals,
      new ToolRegistry([tool('ingest_source', true)]),
      silentLogger,
    );
    const result = await gate(aCall('ingest_source', { url: 'https://x.dev' }), ctx);
    expect(isBlock(result)).toBe(true);
    expect(proposals.created[0]?.summary).toBe('Run "ingest_source"');
    if (isBlock(result)) {
      expect(result.reason).toBe('Run "ingest_source"');
      expect((result.proposal as ProposalDto).summary).toBe('Run "ingest_source"');
    }
  });

  it('passes an unknown tool through (dispatch turns it into an error result)', async () => {
    const gate = createApprovalGate(fakeProposals(), new ToolRegistry(), silentLogger);
    expect(isBlock(await gate(aCall('mystery'), ctx))).toBe(false);
  });
});

describe('createLoggingAfterToolCall', () => {
  it('records the executed call (name + args + result)', async () => {
    const recorded: ToolCallRecord[] = [];
    const log: ToolCallLog = {
      async record(companionId, name, args, result) {
        recorded.push({ id: 'x', companionId, name, args, result, createdAt: new Date() });
      },
      async list() {
        return [];
      },
    };
    const after = createLoggingAfterToolCall(log, silentLogger);
    const out = await after(
      { name: 'web_fetch', content: 'PAGE' },
      aCall('web_fetch', { url: 'u' }),
      ctx,
    );
    expect(out.content).toBe('PAGE');
    expect(recorded).toMatchObject([{ name: 'web_fetch', args: { url: 'u' }, result: 'PAGE' }]);
  });

  it('never throws when logging fails (best-effort)', async () => {
    const log: ToolCallLog = {
      async record() {
        throw new Error('db down');
      },
      async list() {
        return [];
      },
    };
    const after = createLoggingAfterToolCall(log, silentLogger);
    const result = { name: 'web_fetch', content: 'ok' };
    expect(await after(result, aCall('web_fetch'), ctx)).toEqual(result);
  });
});
