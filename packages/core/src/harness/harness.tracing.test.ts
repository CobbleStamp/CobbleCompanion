/**
 * Online tracing (Phase C): the harness opens one turn trace and nests
 * assemble_context / llm_call / tool_call spans through the injected sink. By
 * default (noop) nothing happens; a capturing sink proves the spans + their
 * attributes; a throwing sink proves a misbehaving adapter never breaks a turn.
 */

import type { ChatStreamEvent, CompanionDto, MessageDto, MessageRole } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { FakeLlmGateway, type FakeTurn } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import type { MemoryStore, TranscriptEntry } from '../memory/store.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/tool.js';
import type { SpanKind, SpanStart, TraceSink, TraceStart } from '../tracing/trace-sink.js';
import type { AffectReading } from '../motivation/affect.js';
import type { CompanionAffectStore } from '../motivation/affect-store.js';
import { Harness } from './harness.js';

const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {} };

const companion: CompanionDto = {
  id: 'c1',
  name: 'Cobble',
  form: 'fox',
  temperament: 'curious',
  evolvedPersona: null,
  proactivityDial: 'gentle',
  createdAt: new Date('2026-01-01').toISOString(),
};

function memory(): MemoryStore {
  let count = 0;
  return {
    async appendMessage(
      companionId: string,
      role: MessageRole,
      content: string,
    ): Promise<MessageDto> {
      count += 1;
      return {
        id: `m-${count}`,
        companionId,
        role,
        content,
        kind: 'message',
        sourceId: null,
        createdAt: new Date('2026-01-02').toISOString(),
      };
    },
    async getRecentMessages(): Promise<readonly MessageDto[]> {
      return [];
    },
    async getMessagesSince(): Promise<readonly TranscriptEntry[]> {
      return [];
    },
    async countMessages(): Promise<number> {
      return count;
    },
  };
}

/** Records every trace + span opened, with kinds and attributes, for assertions. */
interface RecordedSpan {
  readonly kind: SpanKind;
  readonly name: string;
  attributes: Record<string, unknown>;
  ended: boolean;
  error?: string;
}
class CapturingSink implements TraceSink {
  start: TraceStart | null = null;
  ended = false;
  readonly spans: RecordedSpan[] = [];
  startTrace(start: TraceStart) {
    this.start = start;
    return {
      startSpan: (span: SpanStart) => {
        const recorded: RecordedSpan = {
          kind: span.kind,
          name: span.name,
          attributes: { ...span.attributes },
          ended: false,
        };
        this.spans.push(recorded);
        return {
          end: (end?: { attributes?: Record<string, unknown>; error?: string }) => {
            recorded.ended = true;
            recorded.attributes = { ...recorded.attributes, ...end?.attributes };
            if (end?.error) recorded.error = end.error;
          },
        };
      },
      end: () => {
        this.ended = true;
      },
    };
  }
}

function recordingTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    effectful: false,
    async run() {
      return { name, content: 'TOOL RESULT' };
    },
  };
}

async function drain(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('Harness tracing (Phase C)', () => {
  it('opens a turn trace with assemble_context + llm_call spans', async () => {
    const sink = new CapturingSink();
    const harness = new Harness({
      gateway: new FakeLlmGateway(['hello']),
      memory: memory(),
      model: 'm',
      logger: silentLogger,
      traceSink: sink,
    });

    await drain(harness.runTurn({ companion, userContent: 'hi', ownerId: 'u1' }));

    expect(sink.start?.name).toBe('turn');
    expect(sink.start?.companionId).toBe('c1');
    expect(sink.ended).toBe(true);
    expect(sink.spans.map((s) => s.kind)).toContain('assemble_context');
    const llm = sink.spans.find((s) => s.kind === 'llm_call');
    expect(llm).toBeDefined();
    expect(llm?.ended).toBe(true);
    // The main turn is stamped with the full persona prompt version triple
    // (id + author semver + content hash) so a trace pins the exact prompt.
    expect(llm?.attributes.promptId).toBe('persona');
    expect(llm?.attributes.promptSemver).toMatch(/^\d+\.\d+\.\d+$/);
    expect(llm?.attributes.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(llm?.attributes.totalTokens).toBeTypeOf('number');
    // No mood note → only the persona was sent, so no co-prompt is stamped.
    expect(llm?.attributes.coPrompts).toBeUndefined();
  });

  it('stamps the affect-attunement line as a co-prompt when a mood note is present', async () => {
    const sink = new CapturingSink();
    // A prior rolling read with a note → assembleContext pushes the attunement
    // line, so the turn's LLM call carries persona + attunement.
    const affectStore: CompanionAffectStore = {
      async get(): Promise<AffectReading | null> {
        return { valence: 0.4, note: 'relieved' };
      },
      async upsert(): Promise<void> {},
    };
    const harness = new Harness({
      gateway: new FakeLlmGateway(['hello']),
      memory: memory(),
      model: 'm',
      logger: silentLogger,
      traceSink: sink,
      affect: { store: affectStore, model: 'cheap' },
    });

    await drain(harness.runTurn({ companion, userContent: 'hi', ownerId: 'u1' }));

    // The persona call (not the background affect-sense call) now also stamps the
    // co-occurring attunement line, so the trace fully describes what was sent.
    const llm = sink.spans.find(
      (s) => s.kind === 'llm_call' && s.attributes.promptId === 'persona',
    );
    expect(llm).toBeDefined();
    const coPrompts = llm?.attributes.coPrompts as
      | ReadonlyArray<{ promptId: string; promptSemver: string; promptHash: string }>
      | undefined;
    expect(coPrompts).toHaveLength(1);
    expect(coPrompts?.[0]?.promptId).toBe('affect-attunement');
    expect(coPrompts?.[0]?.promptSemver).toMatch(/^\d+\.\d+\.\d+$/);
    expect(coPrompts?.[0]?.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('emits a tool_call span for each executed tool', async () => {
    const sink = new CapturingSink();
    const harness = new Harness({
      gateway: new FakeLlmGateway([
        { toolCalls: [{ id: 't1', name: 'web_fetch', args: { url: 'https://x.dev' } }] },
        { chunks: ['done'] },
      ] satisfies FakeTurn[]),
      memory: memory(),
      model: 'm',
      registry: new ToolRegistry([recordingTool('web_fetch')]),
      logger: silentLogger,
      traceSink: sink,
    });

    await drain(harness.runTurn({ companion, userContent: 'read it', ownerId: 'u1' }));

    const toolSpan = sink.spans.find((s) => s.kind === 'tool_call');
    expect(toolSpan?.name).toBe('web_fetch');
    expect(toolSpan?.attributes.tool).toBe('web_fetch');
    expect(toolSpan?.ended).toBe(true);
    // Two llm_call spans (the tool turn + the answer turn).
    expect(sink.spans.filter((s) => s.kind === 'llm_call')).toHaveLength(2);
  });

  it('never lets a throwing sink break the turn', async () => {
    const throwingSink: TraceSink = {
      startTrace() {
        throw new Error('sink boom');
      },
    };
    const harness = new Harness({
      gateway: new FakeLlmGateway(['still works']),
      memory: memory(),
      model: 'm',
      logger: silentLogger,
      traceSink: throwingSink,
    });

    const events = await drain(harness.runTurn({ companion, userContent: 'hi', ownerId: 'u1' }));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.message.content).toBe('still works');
  });
});
