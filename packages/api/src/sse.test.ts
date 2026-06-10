import { InProcessCompanionEventBus, type Logger } from '@cobble/core';
import type { ChatStreamEvent, MessageDto } from '@cobble/shared';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { streamChannel, streamSse } from './sse.js';

interface LogEntry {
  readonly message: string;
  readonly context: Record<string, unknown>;
}

/** Capturing logger so tests can assert disconnects log with context. */
function capturingLogger(error: LogEntry[], info: LogEntry[]): Logger {
  return {
    error: (message, context) => error.push({ message, context }),
    warn: (message, context) => info.push({ message, context: context ?? {} }),
    info: (message, context) => info.push({ message, context: context ?? {} }),
  };
}

/**
 * Minimal fake of the parts of `FastifyReply` that `streamSse` touches. `write`
 * and `end` behaviours are injectable so we can simulate a client that aborts
 * mid-stream (socket throws / reports closed).
 */
function fakeReply(options: {
  writeImpl?: () => void;
  endImpl?: () => void;
  writableEnded?: boolean;
  destroyed?: boolean;
}): { reply: FastifyReply; writes: string[] } {
  const writes: string[] = [];
  const raw = {
    writableEnded: options.writableEnded ?? false,
    destroyed: options.destroyed ?? false,
    setHeader: (): void => {},
    writeHead: (): void => {},
    write: (chunk: string): void => {
      if (options.writeImpl) {
        options.writeImpl();
      }
      writes.push(chunk);
    },
    end: (): void => {
      if (options.endImpl) {
        options.endImpl();
      }
    },
  };
  const reply = {
    hijack: (): void => {},
    getHeaders: (): Record<string, string> => ({}),
    raw,
  } as unknown as FastifyReply;
  return { reply, writes };
}

async function* events(...items: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  for (const item of items) {
    yield item;
  }
}

const TOKEN: ChatStreamEvent = { type: 'token', value: 'hi' };

describe('streamSse', () => {
  it('writes each event to the raw socket and ends', async () => {
    const { reply, writes } = fakeReply({});
    await streamSse(reply, events(TOKEN, TOKEN));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('data: ');
  });

  it('stops and logs at info when a write throws (client disconnect)', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const { reply, writes } = fakeReply({
      writeImpl: () => {
        throw new Error('EPIPE: write after end');
      },
    });

    // Must not reject — a client disconnect is expected, not a failure.
    await streamSse(reply, events(TOKEN, TOKEN), capturingLogger(errors, infos));

    expect(writes).toHaveLength(0); // first write threw, loop broke
    expect(errors).toHaveLength(0); // not error-severity
    expect(infos).toHaveLength(1);
    expect(infos[0]?.context.operation).toBe('sse.stream');
    expect(infos[0]?.context.error).toBeInstanceOf(Error);
  });

  it('stops before writing when the socket already reports ended', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const { reply, writes } = fakeReply({ writableEnded: true });

    await streamSse(reply, events(TOKEN), capturingLogger(errors, infos));

    expect(writes).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(infos).toHaveLength(1);
  });

  it('does not throw when the final end() fails on a closed socket', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const { reply } = fakeReply({
      endImpl: () => {
        throw new Error('ERR_STREAM_WRITE_AFTER_END');
      },
    });

    await expect(
      streamSse(reply, events(TOKEN), capturingLogger(errors, infos)),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(0);
    expect(infos.some((e) => e.message.includes('end failed'))).toBe(true);
  });
});

/** A fake `FastifyRequest` whose `raw` is an emitter, so tests can fire `close`. */
function fakeRequest(): { request: FastifyRequest; close: () => void } {
  const raw = new EventEmitter();
  const request = { raw } as unknown as FastifyRequest;
  return { request, close: () => raw.emit('close') };
}

function message(id: string, companionId: string, content: string): MessageDto {
  return {
    id,
    companionId,
    role: 'assistant',
    content,
    kind: 'message',
    sourceId: null,
    createdAt: '2026-01-03T00:00:00.000Z',
  };
}

/** Let the parked iterator resolve and the loop body run (a macrotask). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('streamChannel', () => {
  it('writes a published row as a message frame, then ends on client close', async () => {
    const bus = new InProcessCompanionEventBus();
    const subscription = bus.subscribe('c1');
    let ended = false;
    const { reply, writes } = fakeReply({ endImpl: () => (ended = true) });
    const { request, close } = fakeRequest();

    const done = streamChannel(reply, request, subscription);
    bus.publish('c1', message('m1', 'c1', 'pushed'));
    await tick();

    // The row is wrapped as a `{ type: 'message' }` SSE data frame.
    const frame = writes.find((w) => w.startsWith('data: '));
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!.slice('data: '.length))).toMatchObject({
      type: 'message',
      message: { id: 'm1', content: 'pushed' },
    });

    close();
    await done;
    expect(ended).toBe(true);

    // After close the subscription is released — a later publish writes nothing.
    const before = writes.length;
    bus.publish('c1', message('m2', 'c1', 'after'));
    await tick();
    expect(writes).toHaveLength(before);
  });

  it('ends without writing a data frame when the client closes before any row', async () => {
    const bus = new InProcessCompanionEventBus();
    const subscription = bus.subscribe('c1');
    let ended = false;
    const { reply, writes } = fakeReply({ endImpl: () => (ended = true) });
    const { request, close } = fakeRequest();

    const done = streamChannel(reply, request, subscription);
    close();
    await done;

    expect(ended).toBe(true);
    expect(writes.some((w) => w.startsWith('data: '))).toBe(false);
  });

  it('emits a heartbeat comment on the interval', async () => {
    vi.useFakeTimers();
    try {
      const bus = new InProcessCompanionEventBus();
      const subscription = bus.subscribe('c1');
      const { reply, writes } = fakeReply({});
      const { request, close } = fakeRequest();

      const done = streamChannel(reply, request, subscription);
      await vi.advanceTimersByTimeAsync(25_000);

      // A comment line (`:`-prefixed) the SSE parser ignores — never a data frame.
      expect(writes.some((w) => w.startsWith(': ping'))).toBe(true);
      expect(writes.some((w) => w.startsWith('data: '))).toBe(false);

      close();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops and logs at info when a write throws (disconnect mid-stream)', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const bus = new InProcessCompanionEventBus();
    const subscription = bus.subscribe('c1');
    const { reply } = fakeReply({
      writeImpl: () => {
        throw new Error('EPIPE: write after end');
      },
    });
    const { request } = fakeRequest();

    const done = streamChannel(reply, request, subscription, capturingLogger(errors, infos));
    bus.publish('c1', message('m1', 'c1', 'x'));
    await done; // the throw breaks the loop → finally cleanup → resolves

    expect(errors).toHaveLength(0); // a disconnect is not error-severity
    expect(infos.some((e) => e.context.operation === 'sse.channel')).toBe(true);
  });
});
