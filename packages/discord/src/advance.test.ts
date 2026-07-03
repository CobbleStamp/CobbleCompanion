/**
 * The mission advance turn handler (`handleAdvance`): the wake stream renders into the
 * owner's DM as a background turn — the spoken report posts, an empty stream is silence
 * (never the "nothing to add" chat fallback), and the server's terminal skip flag (a
 * stale trigger with no active mission) surfaces in the returned outcome so the bridge
 * can undo the summon the trigger caused.
 */

import type { ChatStreamEvent, MessageDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { handleAdvance } from './advance.js';
import type { CompanionConnection } from './bridge.js';
import type { Logger } from './gateway/types.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** A done event carrying an assistant message with the given content. */
function done(content: string): ChatStreamEvent {
  const message = { role: 'assistant', content } as unknown as MessageDto;
  return { type: 'done', message };
}

/** A connection whose callStream replays a scripted turn ending in `result` (or throws). */
function connectionFrom(
  events: ChatStreamEvent[],
  result: unknown,
  throwError?: unknown,
): CompanionConnection {
  return {
    connect: async () => {},
    onSuperseded: () => {},
    onClosed: () => {},
    close: () => {},
    call: <T>(): Promise<T> => Promise.reject(new Error('call() not used in advance tests')),
    async *chat(): AsyncIterable<ChatStreamEvent> {},
    async *callStream(): AsyncGenerator<ChatStreamEvent, unknown> {
      for (const event of events) yield event;
      if (throwError) throw throwError;
      return result;
    },
    async *greeting(): AsyncIterable<ChatStreamEvent> {},
    async *events(): AsyncIterable<never> {},
  };
}

async function run(
  connection: CompanionConnection,
): Promise<{ posts: string[]; skipped: boolean }> {
  const posts: string[] = [];
  const outcome = await handleAdvance(
    connection,
    async (content) => {
      posts.push(content);
    },
    '0f4c10ac-9a3e-4b21-8c53-2f6f14be7a90',
    'LITE is 808',
    silent,
    'u1',
  );
  return { posts, skipped: outcome.skipped };
}

describe('handleAdvance', () => {
  it('posts the spoken report and reports a live (non-skipped) turn', async () => {
    const { posts, skipped } = await run(
      connectionFrom([{ type: 'composing' }, done('LITE crossed 808.')], { done: true }),
    );
    expect(posts).toEqual(['LITE crossed 808.']);
    expect(skipped).toBe(false);
  });

  it('posts nothing and reports skipped on the server’s stale-trigger skip', async () => {
    // A skipped advance emits zero stream events; the skip rides the terminal result.
    const { posts, skipped } = await run(
      connectionFrom([], { done: true, skipped: 'mission not active' }),
    );
    expect(posts).toEqual([]); // silence — not "I don't have anything to add to that."
    expect(skipped).toBe(true);
  });

  it('renders silence (no empty-reply fallback) for a live turn that spoke nothing', async () => {
    // e.g. a wake superseded mid-turn: the stream ends without a done event.
    const { posts, skipped } = await run(connectionFrom([{ type: 'composing' }], { done: true }));
    expect(posts).toEqual([]);
    expect(skipped).toBe(false);
  });

  it('treats a mid-stream throw as a rendered error, never as a skip', async () => {
    const { posts, skipped } = await run(
      connectionFrom([{ type: 'composing' }], undefined, new Error('boom')),
    );
    expect(posts).toHaveLength(1); // the renderer's generic-error reply
    expect(skipped).toBe(false);
  });
});
