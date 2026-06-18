/**
 * Mid-turn embodiment fence (deliver-scalability.md §5.2). A turn is a multi-step
 * agent loop, so the per-request `holds()` check can't stop a turn already running
 * when a newer connection force-claims the companion (the user moved rooms). The
 * harness re-reads the lease at the top of every iteration and again before
 * persisting the reply, and stands down cleanly — no assistant write, no post-turn
 * nudge — surfacing the handoff via the generator's terminal return value.
 */

import type {
  ChatStreamEvent,
  CompanionDto,
  MessageDto,
  MessageRole,
  ProposalDto,
} from '@cobble/shared';
import { describe, expect, it, vi } from 'vitest';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import type { AppendOptions, MemoryStore, TranscriptEntry } from '../memory/store.js';
import type { AffectReading } from '../motivation/affect.js';
import type { CompanionAffectStore } from '../motivation/affect-store.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/tool.js';
import { Harness, type HarnessAffect } from './harness.js';
import type { Block, ToolCall as HookToolCall, TurnCtx } from './hooks.js';
import type { ToolCall } from '../llm/gateway.js';

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

/** A no-DB fake transcript that records every appended row. */
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
    async getMessageById(): Promise<MessageDto | null> {
      return null;
    },
    async getMessagesSince(): Promise<readonly TranscriptEntry[]> {
      return [];
    },
    async countMessages(): Promise<number> {
      return appended.length;
    },
  };
}

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

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `id-${name}`,
  name,
  args,
});

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

/** In-memory affect store (the perceiveAndLearn path is gated by supersede here). */
function affectStore(): CompanionAffectStore {
  let value: AffectReading | null = null;
  return {
    async get(): Promise<AffectReading | null> {
      return value;
    },
    async upsert(_companionId: string, reading: AffectReading): Promise<void> {
      value = reading;
    },
  };
}

/** A flip-able lease: returns the queued values in order, repeating the last. */
function scriptedLease(...values: boolean[]): { fn: () => Promise<boolean>; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    fn: async () => {
      const value = values[Math.min(state.calls, values.length - 1)] ?? true;
      state.calls += 1;
      return value;
    },
  };
}

/** Drive a runTurn/continueAfterApproval generator, capturing its terminal value. */
async function drive(
  gen: AsyncGenerator<ChatStreamEvent, boolean>,
): Promise<{ events: ChatStreamEvent[]; superseded: boolean }> {
  const events: ChatStreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, superseded: next.value };
}

describe('Harness mid-turn embodiment fence (§5.2)', () => {
  it('stands down at the next iteration when the lease moves mid-turn', async () => {
    const tool = recordingTool('web_fetch', false, 'PAGE TEXT');
    const gateway = new FakeLlmGateway([
      { chunks: ['Reading… '], toolCalls: [call('web_fetch', { url: 'https://x.dev' })] },
      { chunks: ['the answer is 42.'] }, // never reached — superseded first
    ] satisfies FakeTurn[]);
    const mem = memory();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      registry: new ToolRegistry([tool]),
      logger: silentLogger,
    });
    // Held at the top of iteration 0; lost by the top of iteration 1.
    const lease = scriptedLease(true, false);

    const { events, superseded } = await drive(
      harness.runTurn({
        companion,
        userContent: 'read it',
        ownerId: 'u1',
        holdsLease: lease.fn,
      }),
    );

    expect(superseded).toBe(true);
    expect(lease.calls).toBe(2); // top of iter 0 (held) + top of iter 1 (lost)
    expect(events.some((e) => e.type === 'done')).toBe(false);
    // No assistant ANSWER row was persisted (the second model turn never ran).
    expect(
      mem.appended.some((m) => m.role === 'assistant' && (m.kind ?? 'message') === 'message'),
    ).toBe(false);
    // The user message + the in-flight iteration's tool-step are the bounded overlap.
    expect(mem.appended.map((m) => m.kind ?? 'message')).toEqual(['message', 'tool_step']);
  });

  it('does not write the reply if the lease moves during the final LLM call', async () => {
    const gateway = new FakeLlmGateway([{ chunks: ['Here is the answer.'] }]);
    const mem = memory();
    const quota = new RecordingQuota();
    const harness = new Harness({
      gateway,
      memory: mem,
      model: 'm',
      quota,
      logger: silentLogger,
    });
    // Held at the top of iteration 0; lost on the pre-finish re-check (after the call).
    const lease = scriptedLease(true, false);

    const { events, superseded } = await drive(
      harness.runTurn({ companion, userContent: 'hi', ownerId: 'u1', holdsLease: lease.fn }),
    );

    expect(superseded).toBe(true);
    expect(lease.calls).toBe(2); // top of loop (held) + pre-finish (lost)
    expect(events.some((e) => e.type === 'done')).toBe(false);
    // Only the user message persisted — no assistant reply.
    expect(mem.appended.map((m) => m.role)).toEqual(['user']);
    // The metered tokens are still debited (the call really happened).
    expect(quota.recorded.length).toBe(1);
    expect(quota.recorded[0]).toBeGreaterThan(0);
  });

  it('skips the post-turn affect nudge when the turn stands down', async () => {
    const gateway = new FakeLlmGateway([{ chunks: ['hello'] }]);
    const reinforce = vi.fn(async () => undefined);
    const affect: HarnessAffect = { store: affectStore(), model: 'mood', reinforce };
    const harness = new Harness({
      gateway,
      memory: memory(),
      model: 'm',
      affect,
      logger: silentLogger,
    });

    const { superseded } = await drive(
      harness.runTurn({
        companion,
        userContent: 'hi',
        ownerId: 'u1',
        holdsLease: scriptedLease(true, false).fn,
      }),
    );
    await harness.whenIdle();

    expect(superseded).toBe(true);
    // The non-idempotent driveWeights nudge must NOT fire for a superseded turn.
    expect(reinforce).not.toHaveBeenCalled();
  });

  it('does not persist a held proposal when the lease moves before the exit', async () => {
    const tool = recordingTool('ingest_source', true, 'ingested');
    const proposal: ProposalDto = {
      id: 'p1',
      toolName: 'ingest_source',
      summary: 'Remember https://x.dev',
      status: 'pending',
      createdAt: new Date('2026-01-02').toISOString(),
    };
    const gate = async (c: HookToolCall, _ctx: TurnCtx): Promise<HookToolCall | Block> =>
      c.name === 'ingest_source' ? { blocked: true, reason: 'needs approval', proposal } : c;
    const gateway = new FakeLlmGateway([
      {
        chunks: ['Let me save that. '],
        toolCalls: [call('ingest_source', { url: 'https://x.dev' })],
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
    // Held at the top of iteration 0; lost on the pre-finishBlocked re-check.
    const lease = scriptedLease(true, false);

    const { events, superseded } = await drive(
      harness.runTurn({ companion, userContent: 'save it', ownerId: 'u1', holdsLease: lease.fn }),
    );

    expect(superseded).toBe(true);
    expect(tool.calls).toEqual([]); // nothing effectful ran
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    // No pre-amble row, no proposal row — only the user message.
    expect(mem.appended.map((m) => m.role)).toEqual(['user']);
  });

  it('completes normally and reports not-superseded when the lease holds', async () => {
    const gateway = new FakeLlmGateway([{ chunks: ['done'] }]);
    const mem = memory();
    const harness = new Harness({ gateway, memory: mem, model: 'm', logger: silentLogger });

    const { events, superseded } = await drive(
      harness.runTurn({
        companion,
        userContent: 'hi',
        ownerId: 'u1',
        holdsLease: async () => true,
      }),
    );

    expect(superseded).toBe(false);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('done');
    expect(mem.appended.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('runs to completion unchanged when no lease fence is wired', async () => {
    const gateway = new FakeLlmGateway([{ chunks: ['answer'] }]);
    const harness = new Harness({ gateway, memory: memory(), model: 'm', logger: silentLogger });

    const { events, superseded } = await drive(
      harness.runTurn({ companion, userContent: 'hi', ownerId: 'u1' }),
    );

    expect(superseded).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
