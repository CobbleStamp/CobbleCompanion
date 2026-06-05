import type { Logger } from '@cobble/core';
import type { ChatStreamEvent } from '@cobble/shared';
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { streamSse } from './sse.js';

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
