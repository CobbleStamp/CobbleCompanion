import type { ChatStreamEvent, MessageDto, ProposalDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import type { CompanionConnection } from './bridge.js';
import { handleChat } from './chat.js';
import type { DirectMessageContext } from './gateway/manager.js';
import type { Logger, ProposalCard } from './gateway/types.js';
import { WsCallError } from './ws-client.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** A done event carrying an assistant message with the given content. */
function done(content: string): ChatStreamEvent {
  const message = { role: 'assistant', content } as unknown as MessageDto;
  return { type: 'done', message };
}

/** A connection whose chat() replays a scripted stream (or throws). */
function connectionFrom(events: ChatStreamEvent[], throwError?: unknown): CompanionConnection {
  return {
    connect: async () => {},
    onSuperseded: () => {},
    close: () => {},
    call: <T>(): Promise<T> => Promise.reject(new Error('call() not used in chat tests')),
    async *chat(): AsyncIterable<ChatStreamEvent> {
      for (const event of events) yield event;
      if (throwError) throw throwError;
    },
    async *callStream(): AsyncIterable<ChatStreamEvent> {
      // Not used in chat tests (chat() is the streaming path here).
    },
  };
}

function ctxFor(content: string): {
  ctx: DirectMessageContext;
  replies: string[];
  proposals: ProposalCard[];
  typingCount: () => number;
} {
  const replies: string[] = [];
  const proposals: ProposalCard[] = [];
  let typing = 0;
  return {
    replies,
    proposals,
    typingCount: () => typing,
    ctx: {
      userId: 'u1',
      config: {
        userId: 'u1',
        encryptedBotToken: 'x',
        boundCompanionId: 'c1',
        ownerDiscordUserId: 'owner-1',
        linkCode: null,
        linkCodeIssuedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      message: { authorId: 'owner-1', channelId: 'dm-1', content },
      reply: async (c) => {
        replies.push(c);
      },
      typing: async () => {
        typing += 1;
      },
      sendProposal: async (card) => {
        proposals.push(card);
      },
    },
  };
}

describe('handleChat', () => {
  it('posts the done message as a single reply', async () => {
    const { ctx, replies } = ctxFor('hello');
    await handleChat(ctx, connectionFrom([{ type: 'composing' }, done('Hi there!')]), silent);
    expect(replies).toEqual(['Hi there!']);
  });

  it('shows the typing cue on composing', async () => {
    const { ctx, typingCount } = ctxFor('hello');
    await handleChat(ctx, connectionFrom([{ type: 'composing' }, done('ok')]), silent);
    expect(typingCount()).toBe(1);
  });

  it('ignores token/tool_step chunks and uses the done content', async () => {
    const { ctx, replies } = ctxFor('hello');
    await handleChat(
      ctx,
      connectionFrom([
        { type: 'composing' },
        { type: 'token', value: 'He' },
        { type: 'token', value: 'llo' },
        done('Hello, fully formed.'),
      ]),
      silent,
    );
    expect(replies).toEqual(['Hello, fully formed.']);
  });

  it('nudges to feed on an over_cap rejection', async () => {
    const { ctx, replies } = ctxFor('hello');
    await handleChat(ctx, connectionFrom([], new WsCallError('over cap', 'over_cap')), silent);
    expect(replies[0]).toContain('/feed');
  });

  it('posts a generic error on an unexpected throw', async () => {
    const { ctx, replies } = ctxFor('hello');
    await handleChat(ctx, connectionFrom([], new Error('boom')), silent);
    expect(replies[0]).toContain('went wrong');
  });

  it('relays a mid-turn error event as the reply', async () => {
    const { ctx, replies } = ctxFor('hello');
    await handleChat(
      ctx,
      connectionFrom([{ type: 'composing' }, { type: 'error', message: 'I had trouble there.' }]),
      silent,
    );
    expect(replies).toEqual(['I had trouble there.']);
  });

  it('falls back when the stream ends with no content', async () => {
    const { ctx, replies } = ctxFor('hello');
    await handleChat(ctx, connectionFrom([{ type: 'composing' }]), silent);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toBeTruthy();
  });

  it('cards a proposal and does not also post a redundant done line', async () => {
    const { ctx, replies, proposals } = ctxFor('book me a table');
    const proposal = {
      id: 'p1',
      toolName: 'book_table',
      summary: 'Book a table for two at 7pm.',
      status: 'pending',
      createdAt: '2026-06-26T00:00:00Z',
    } satisfies ProposalDto;
    await handleChat(
      ctx,
      // The harness terminates a held turn with a done carrying the proposal summary.
      connectionFrom([
        { type: 'composing' },
        { type: 'proposal', proposal },
        done(proposal.summary),
      ]),
      silent,
    );
    expect(proposals).toEqual([
      { proposalId: 'p1', toolName: 'book_table', summary: 'Book a table for two at 7pm.' },
    ]);
    expect(replies).toHaveLength(0); // the card IS the message
  });

  it('cards a proposal AND posts the spoken preamble when the companion also spoke', async () => {
    const { ctx, replies, proposals } = ctxFor('book me a table');
    const proposal = {
      id: 'p2',
      toolName: 'book_table',
      summary: 'Book a table for two at 7pm.',
      status: 'pending',
      createdAt: '2026-06-26T00:00:00Z',
    } satisfies ProposalDto;
    await handleChat(
      ctx,
      connectionFrom([
        { type: 'composing' },
        { type: 'proposal', proposal },
        done('Sure — here’s what I’d do, okay?'),
      ]),
      silent,
    );
    expect(proposals).toHaveLength(1);
    expect(replies).toEqual(['Sure — here’s what I’d do, okay?']);
  });
});
