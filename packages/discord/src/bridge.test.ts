import type { DiscordConfigRecord } from '@cobble/db';
import { describe, expect, it } from 'vitest';
import {
  CompanionBridge,
  type CompanionBridgeOptions,
  type CompanionConnection,
} from './bridge.js';
import type {
  DirectMessageContext,
  ProposalActionContext,
  SlashCommandContext,
} from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { SupersededError } from './ws-client.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** A connection whose connect outcome and supersession the test drives by hand. */
class FakeConnection implements CompanionConnection {
  connected = false;
  closed = false;
  outcome: 'ok' | 'superseded' = 'ok';
  private supersededHandler: () => void = () => {};

  async connect(): Promise<void> {
    if (this.outcome === 'superseded') throw new SupersededError();
    this.connected = true;
  }
  onSuperseded(handler: () => void): void {
    this.supersededHandler = handler;
  }
  async *chat(): AsyncIterable<never> {
    // Not exercised here; the chat renderer is tested in chat.test.ts.
  }
  async *callStream(): AsyncIterable<never> {
    // Not exercised here; the proposal renderer is tested in proposals.test.ts.
  }
  call<T>(): Promise<T> {
    // Not exercised here; the read-only views are tested in read-commands.test.ts.
    return Promise.reject(new Error('call() not used in bridge tests'));
  }
  close(): void {
    this.closed = true;
  }
  /** Fire a post-ready takeover. */
  triggerSuperseded(): void {
    this.supersededHandler();
  }
}

function record(): DiscordConfigRecord {
  return {
    userId: 'u1',
    encryptedBotToken: 'v1.a.b.c',
    boundCompanionId: 'companion-u1',
    ownerDiscordUserId: 'owner-123',
    linkCode: null,
    linkCodeIssuedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function cmdCtx(name: string): { ctx: SlashCommandContext; replies: string[] } {
  const replies: string[] = [];
  const reply = async (c: string): Promise<void> => {
    replies.push(c);
  };
  return {
    replies,
    ctx: {
      userId: 'u1',
      config: record(),
      command: { name, userId: 'owner-123', channelId: 'dm-1', options: {}, reply },
      reply,
    },
  };
}

function dmCtx(content: string): { ctx: DirectMessageContext; replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      userId: 'u1',
      config: record(),
      message: { authorId: 'owner-123', channelId: 'dm-1', content },
      reply: async (c) => {
        replies.push(c);
      },
      typing: async () => {},
      sendProposal: async () => {},
    },
  };
}

function proposalCtx(
  action: 'confirm' | 'reject',
  discordUserId = 'owner-123',
): { ctx: ProposalActionContext; replies: string[]; updates: string[] } {
  const replies: string[] = [];
  const updates: string[] = [];
  return {
    replies,
    updates,
    ctx: {
      userId: 'u1',
      config: record(),
      proposalId: 'p1',
      action,
      discordUserId,
      reply: async (c) => {
        replies.push(c);
      },
      update: async (c) => {
        updates.push(c);
      },
      typing: async () => {},
      sendProposal: async () => {},
    },
  };
}

interface Harness {
  bridge: CompanionBridge;
  connections: FakeConnection[];
  notices: Array<{ userId: string; channelId: string; content: string }>;
  chats: DirectMessageContext[];
  readOnly: Array<{ ctx: SlashCommandContext; connection: CompanionConnection }>;
  proposalActions: Array<{ ctx: ProposalActionContext; connection: CompanionConnection }>;
}

function makeBridge(
  opts: { outcome?: 'ok' | 'superseded'; overrides?: Partial<CompanionBridgeOptions> } = {},
): Harness {
  const outcome = opts.outcome ?? 'ok';
  const connections: FakeConnection[] = [];
  const notices: Harness['notices'] = [];
  const chats: DirectMessageContext[] = [];
  const readOnly: Harness['readOnly'] = [];
  const proposalActions: Harness['proposalActions'] = [];
  const bridge = new CompanionBridge({
    connectionFactory: () => {
      const connection = new FakeConnection();
      connection.outcome = outcome;
      connections.push(connection);
      return connection;
    },
    notify: async (userId, channelId, content) => {
      notices.push({ userId, channelId, content });
    },
    onChat: (ctx) => {
      chats.push(ctx);
    },
    onReadOnlyCommand: (ctx, connection) => {
      readOnly.push({ ctx, connection });
    },
    onProposalAction: (ctx, connection) => {
      proposalActions.push({ ctx, connection });
    },
    logger: silent,
    ...opts.overrides,
  });
  return { bridge, connections, notices, chats, readOnly, proposalActions };
}

describe('CompanionBridge — summon', () => {
  it('claims the companion and marks the user summoned', async () => {
    const h = makeBridge();
    const { ctx, replies } = cmdCtx('summon');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.connections[0]?.connected).toBe(true);
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(replies[0]).toContain('here');
  });

  it('reports being active elsewhere when the claim is superseded on connect', async () => {
    const h = makeBridge({ outcome: 'superseded' });
    const { ctx, replies } = cmdCtx('summon');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.bridge.isSummoned('u1')).toBe(false);
    expect(replies[0]).toContain('somewhere else');
  });

  it('is idempotent when already summoned', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const { ctx, replies } = cmdCtx('summon');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.connections).toHaveLength(1); // no second connection
    expect(replies[0]).toContain('already here');
  });
});

describe('CompanionBridge — status', () => {
  it('reflects dormant then summoned', async () => {
    const h = makeBridge();
    const dormant = cmdCtx('status');
    await h.bridge.handleOwnerCommand(dormant.ctx);
    expect(dormant.replies[0]).toContain('not here');

    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const active = cmdCtx('status');
    await h.bridge.handleOwnerCommand(active.ctx);
    expect(active.replies[0]).toContain('here in this chat');
  });
});

describe('CompanionBridge — supersession', () => {
  it('tears down and DMs the notice when the room is taken over', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    expect(h.bridge.isSummoned('u1')).toBe(true);

    h.connections[0]!.triggerSuperseded();
    await Promise.resolve(); // let the async handler settle

    expect(h.bridge.isSummoned('u1')).toBe(false);
    expect(h.connections[0]?.closed).toBe(true);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ userId: 'u1', channelId: 'dm-1' });
    expect(h.notices[0]?.content).toContain('/summon');
  });
});

describe('CompanionBridge — owner DM gating', () => {
  it('asks to summon when dormant', async () => {
    const h = makeBridge();
    const { ctx, replies } = dmCtx('hi cobble');

    await h.bridge.handleOwnerMessage(ctx);

    expect(replies[0]).toContain('/summon');
    expect(h.chats).toHaveLength(0);
  });

  it('routes to chat when summoned', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const { ctx } = dmCtx('what is up');

    await h.bridge.handleOwnerMessage(ctx);

    expect(h.chats).toHaveLength(1);
    expect(h.chats[0]?.message.content).toBe('what is up');
  });
});

describe('CompanionBridge — proposal actions', () => {
  it('asks to summon when a proposal button is clicked while dormant', async () => {
    const h = makeBridge();
    const { ctx, replies } = proposalCtx('confirm');

    await h.bridge.handleProposalAction(ctx);

    expect(h.proposalActions).toHaveLength(0);
    expect(replies[0]).toContain('/summon');
  });

  it('delegates to the handler with the live connection when summoned', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const { ctx } = proposalCtx('confirm');

    await h.bridge.handleProposalAction(ctx);

    expect(h.proposalActions).toHaveLength(1);
    expect(h.proposalActions[0]?.connection).toBe(h.connections[0]);
  });

  it('ignores a click from a non-owner Discord id', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const { ctx, replies } = proposalCtx('confirm', 'intruder-999');

    await h.bridge.handleProposalAction(ctx);

    expect(h.proposalActions).toHaveLength(0);
    expect(replies).toHaveLength(0); // silently ignored
  });
});

describe('CompanionBridge — read-only views', () => {
  it('asks to summon when a view is run while dormant', async () => {
    const h = makeBridge();
    const { ctx, replies } = cmdCtx('memory');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.readOnly).toHaveLength(0); // gated: the view never ran
    expect(replies[0]).toContain('/summon');
  });

  it('delegates to the read-only handler with the live connection when summoned', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const { ctx } = cmdCtx('memory');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.readOnly).toHaveLength(1);
    expect(h.readOnly[0]?.ctx.command.name).toBe('memory');
    // The summoned connection is handed to the view (so it can call companion-scoped methods).
    expect(h.readOnly[0]?.connection).toBe(h.connections[0]);
  });
});
