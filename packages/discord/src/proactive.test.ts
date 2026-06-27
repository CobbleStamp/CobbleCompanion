import type { ChatStreamEvent, CompanionStreamEvent, MessageDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import type { CompanionConnection } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { runProactiveLoop, streamGreeting } from './proactive.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

function assistantMessage(id: string, content: string): CompanionStreamEvent {
  return { type: 'message', message: { id, role: 'assistant', content } as unknown as MessageDto };
}

/** A connection whose greeting()/events() replay scripted streams. */
function connectionFrom(opts: {
  greeting?: ChatStreamEvent[];
  events?: CompanionStreamEvent[];
}): CompanionConnection {
  return {
    connect: async () => {},
    onSuperseded: () => {},
    onClosed: () => {},
    close: () => {},
    async *chat(): AsyncIterable<ChatStreamEvent> {},
    async *callStream(): AsyncIterable<ChatStreamEvent> {},
    call: <T>(): Promise<T> => Promise.reject(new Error('call() not used here')),
    async *greeting(): AsyncIterable<ChatStreamEvent> {
      for (const event of opts.greeting ?? []) yield event;
    },
    async *events(): AsyncIterable<CompanionStreamEvent> {
      for (const event of opts.events ?? []) yield event;
    },
  };
}

function done(content: string): ChatStreamEvent {
  return {
    type: 'done',
    message: { id: 'g1', role: 'assistant', content } as unknown as MessageDto,
  };
}

describe('streamGreeting', () => {
  it('posts the greeting when the companion greets', async () => {
    const posted: string[] = [];
    await streamGreeting(
      connectionFrom({ greeting: [{ type: 'composing' }, done('Hey, good to see you!')] }),
      async (c) => void posted.push(c),
      silent,
      { operation: 'g', userId: 'u1' },
    );
    expect(posted).toEqual(['Hey, good to see you!']);
  });

  it('stays silent when the companion does not greet (empty stream)', async () => {
    const posted: string[] = [];
    await streamGreeting(
      connectionFrom({ greeting: [] }),
      async (c) => void posted.push(c),
      silent,
      { operation: 'g', userId: 'u1' },
    );
    expect(posted).toEqual([]);
  });
});

describe('runProactiveLoop', () => {
  it('forwards autonomous assistant messages as DMs', async () => {
    const posted: string[] = [];
    await runProactiveLoop(
      connectionFrom({
        events: [assistantMessage('m1', 'Thinking about you — found something neat.')],
      }),
      async (c) => void posted.push(c),
      silent,
      { operation: 'p', userId: 'u1' },
      new AbortController().signal,
    );
    expect(posted).toEqual(['Thinking about you — found something neat.']);
  });

  it('ignores reaction events and empty messages', async () => {
    const posted: string[] = [];
    await runProactiveLoop(
      connectionFrom({
        events: [
          { type: 'reaction_added', messageId: 'm1', reactor: 'companion', emoji: '✨' },
          assistantMessage('m2', '   '),
        ],
      }),
      async (c) => void posted.push(c),
      silent,
      { operation: 'p', userId: 'u1' },
      new AbortController().signal,
    );
    expect(posted).toEqual([]);
  });
});
