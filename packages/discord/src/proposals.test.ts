import type { ChatStreamEvent, MessageDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import type { CompanionConnection } from './bridge.js';
import type { ProposalActionContext } from './gateway/manager.js';
import type { Logger, ProposalCard } from './gateway/types.js';
import { handleProposalAction } from './proposals.js';
import { WsCallError } from './ws-client.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

function done(content: string): ChatStreamEvent {
  return { type: 'done', message: { role: 'assistant', content } as unknown as MessageDto };
}

/** A connection recording its calls; callStream replays a scripted turn (or throws). */
function connectionFrom(opts: {
  stream?: ChatStreamEvent[];
  streamThrows?: unknown;
  rejectThrows?: unknown;
}): CompanionConnection & { readonly calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    connect: async () => {},
    onSuperseded: () => {},
    close: () => {},
    async *chat(): AsyncIterable<ChatStreamEvent> {},
    async *callStream(method, params): AsyncIterable<ChatStreamEvent> {
      calls.push({ method, params });
      if (opts.streamThrows) throw opts.streamThrows;
      for (const event of opts.stream ?? []) yield event;
    },
    call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (opts.rejectThrows) return Promise.reject(opts.rejectThrows);
      return Promise.resolve(undefined as T);
    },
  };
}

function ctxFor(action: 'confirm' | 'reject'): {
  ctx: ProposalActionContext;
  replies: string[];
  updates: string[];
  proposals: ProposalCard[];
} {
  const replies: string[] = [];
  const updates: string[] = [];
  const proposals: ProposalCard[] = [];
  return {
    replies,
    updates,
    proposals,
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
      proposalId: 'p1',
      action,
      discordUserId: 'owner-1',
      reply: async (c) => {
        replies.push(c);
      },
      update: async (c) => {
        updates.push(c);
      },
      typing: async () => {},
      sendProposal: async (card) => {
        proposals.push(card);
      },
    },
  };
}

describe('handleProposalAction — reject', () => {
  it('calls proposals.reject and updates the embed', async () => {
    const { ctx, updates } = ctxFor('reject');
    const connection = connectionFrom({});
    await handleProposalAction(ctx, connection, silent);
    expect(connection.calls).toEqual([
      { method: 'proposals.reject', params: { proposalId: 'p1' } },
    ]);
    expect(updates[0]).toContain('won’t');
  });

  it('reports a generic error if reject fails', async () => {
    const { ctx, replies } = ctxFor('reject');
    const connection = connectionFrom({ rejectThrows: new Error('boom') });
    await handleProposalAction(ctx, connection, silent);
    expect(replies[0]).toContain('went wrong');
  });
});

describe('handleProposalAction — confirm', () => {
  it('marks resolved then streams the post-approval turn as a reply', async () => {
    const { ctx, replies, updates } = ctxFor('confirm');
    const connection = connectionFrom({ stream: [{ type: 'composing' }, done('Booked it. ✅')] });
    await handleProposalAction(ctx, connection, silent);
    expect(connection.calls[0]).toEqual({
      method: 'proposals.confirm',
      params: { proposalId: 'p1' },
    });
    expect(updates[0]).toContain('Confirmed');
    expect(replies).toEqual(['Booked it. ✅']);
  });

  it('nudges to feed on an over_cap rejection mid-confirm', async () => {
    const { ctx, replies } = ctxFor('confirm');
    const connection = connectionFrom({ streamThrows: new WsCallError('over cap', 'over_cap') });
    await handleProposalAction(ctx, connection, silent);
    expect(replies[0]).toContain('/feed');
  });

  it('explains a conflict (already handled) without a generic error', async () => {
    const { ctx, replies } = ctxFor('confirm');
    const connection = connectionFrom({ streamThrows: new WsCallError('gone', 'conflict') });
    await handleProposalAction(ctx, connection, silent);
    expect(replies[0]).toContain('no longer waiting');
  });
});
