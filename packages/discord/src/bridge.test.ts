import type { DiscordConfigRecord, DiscordConfigStore } from '@cobble/db';
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
  /** When true, fire the takeover the instant the lease is granted — before the
   * bridge registers the embodiment (the connect→register race). */
  supersedeOnConnect = false;
  private supersededHandler: () => void = () => {};
  private closedHandler: () => void = () => {};

  async connect(): Promise<void> {
    if (this.outcome === 'superseded') throw new SupersededError();
    this.connected = true;
    if (this.supersedeOnConnect) this.supersededHandler();
  }
  onSuperseded(handler: () => void): void {
    this.supersededHandler = handler;
  }
  onClosed(handler: () => void): void {
    this.closedHandler = handler;
  }
  async *chat(): AsyncIterable<never> {
    // Not exercised here; the chat renderer is tested in chat.test.ts.
  }
  async *callStream(): AsyncIterable<never> {
    // Not exercised here; the proposal renderer is tested in proposals.test.ts.
  }
  async *greeting(): AsyncIterable<never> {
    // Not exercised here; greeting/proactive are tested in proactive.test.ts.
  }
  async *events(): AsyncIterable<never> {
    // Empty + returns immediately: the proactive loop ends at once in bridge tests.
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
  /** Fire an unexpected socket drop (not a supersession, not a deliberate close). */
  triggerClosed(): void {
    this.closedHandler();
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
    triggerBotId: null,
    missionChannelId: null,
    botUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Config store the bridge reads on demand: returns the one user's record. */
const configStore: DiscordConfigStore = {
  findByUserId: async (userId) => (userId === 'u1' ? record() : null),
  list: async () => [record()],
  upsert: async () => record(),
  reissueLinkCode: async () => record(),
  bindOwner: async () => true,
  configureMissionWake: async () => record(),
  setBotUserId: async () => record(),
  delete: async () => {},
};

function cmdCtx(name: string): { ctx: SlashCommandContext; replies: string[] } {
  const replies: string[] = [];
  const reply = async (c: string): Promise<void> => {
    replies.push(c);
  };
  return {
    replies,
    ctx: {
      userId: 'u1',
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
  advances: Array<{ connection: CompanionConnection; event: string; userId: string }>;
  openedDms: Array<{ userId: string; discordUserId: string }>;
}

function makeBridge(
  opts: {
    outcome?: 'ok' | 'superseded';
    supersedeOnConnect?: boolean;
    overrides?: Partial<CompanionBridgeOptions>;
  } = {},
): Harness {
  const outcome = opts.outcome ?? 'ok';
  const connections: FakeConnection[] = [];
  const notices: Harness['notices'] = [];
  const chats: DirectMessageContext[] = [];
  const readOnly: Harness['readOnly'] = [];
  const proposalActions: Harness['proposalActions'] = [];
  const advances: Harness['advances'] = [];
  const openedDms: Harness['openedDms'] = [];
  const bridge = new CompanionBridge({
    connectionFactory: () => {
      const connection = new FakeConnection();
      connection.outcome = outcome;
      connection.supersedeOnConnect = opts.supersedeOnConnect ?? false;
      connections.push(connection);
      return connection;
    },
    configStore,
    notify: async (userId, channelId, content) => {
      notices.push({ userId, channelId, content });
    },
    openOwnerDm: async (userId, discordUserId) => {
      openedDms.push({ userId, discordUserId });
      return `dm:${discordUserId}`;
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
    onMissionAdvance: (connection, _post, event, userId) => {
      advances.push({ connection, event, userId });
    },
    logger: silent,
    ...opts.overrides,
  });
  return { bridge, connections, notices, chats, readOnly, proposalActions, advances, openedDms };
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

  it('does not strand a phantom embodiment when superseded before registration', async () => {
    // The takeover fires the instant the lease is granted — after connect() resolves
    // but before the bridge registers the embodiment in `active`.
    const h = makeBridge({ supersedeOnConnect: true });
    const { ctx, replies } = cmdCtx('summon');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.bridge.isSummoned('u1')).toBe(false); // not registered
    expect(h.connections[0]?.closed).toBe(true); // dead connection torn down, not leaked
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

describe('CompanionBridge — unexpected close', () => {
  it('clears the embodiment and DMs when the socket drops', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    expect(h.bridge.isSummoned('u1')).toBe(true);

    h.connections[0]!.triggerClosed();
    await Promise.resolve(); // let the async teardown settle

    // No phantom: the next /summon must reconnect, not be refused as "already here".
    expect(h.bridge.isSummoned('u1')).toBe(false);
    expect(h.connections[0]?.closed).toBe(true);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ userId: 'u1', channelId: 'dm-1' });
    expect(h.notices[0]?.content).toContain('/summon');
  });

  it('lets the owner re-summon after an unexpected drop', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    h.connections[0]!.triggerClosed();
    await Promise.resolve();

    const { ctx, replies } = cmdCtx('summon');
    await h.bridge.handleOwnerCommand(ctx);

    expect(h.connections).toHaveLength(2); // a fresh connection, not a no-op
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(replies[0]).toContain('here');
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

describe('CompanionBridge — mission trigger', () => {
  it('summons-if-dormant, opens the owner DM, and advances the mission', async () => {
    const h = makeBridge();

    await h.bridge.handleTrigger('u1', 'LITE is 808');

    expect(h.openedDms).toEqual([{ userId: 'u1', discordUserId: 'owner-123' }]);
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.connections).toHaveLength(1);
    expect(h.advances).toHaveLength(1);
    expect(h.advances[0]?.event).toBe('LITE is 808');
  });

  it('advances over the live connection when already embodied (no re-summon)', async () => {
    const h = makeBridge();
    const { ctx } = cmdCtx('summon');
    await h.bridge.handleOwnerCommand(ctx);
    expect(h.connections).toHaveLength(1);

    await h.bridge.handleTrigger('u1', 'threshold crossed');

    // No new connection opened, no owner DM re-opened — reused the live embodiment.
    expect(h.connections).toHaveLength(1);
    expect(h.openedDms).toHaveLength(0);
    expect(h.advances).toHaveLength(1);
    expect(h.advances[0]?.event).toBe('threshold crossed');
  });

  it('drops a trigger for an unlinked user (no owner DM to report into)', async () => {
    const unlinkedStore: DiscordConfigStore = {
      findByUserId: async () => ({
        userId: 'u1',
        encryptedBotToken: 'v1.a.b.c',
        boundCompanionId: 'companion-u1',
        ownerDiscordUserId: null,
        linkCode: null,
        linkCodeIssuedAt: null,
        triggerBotId: null,
        missionChannelId: null,
        botUserId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      list: async () => [],
      upsert: async () => {
        throw new Error('unused');
      },
      reissueLinkCode: async () => null,
      bindOwner: async () => false,
      configureMissionWake: async () => null,
      setBotUserId: async () => null,
      delete: async () => {},
    };
    const h = makeBridge({ overrides: { configStore: unlinkedStore } });

    await h.bridge.handleTrigger('u1', 'event');

    expect(h.bridge.isSummoned('u1')).toBe(false);
    expect(h.advances).toHaveLength(0);
    expect(h.openedDms).toHaveLength(0);
  });
});

describe('CompanionBridge — /mission summon-if-dormant', () => {
  it('summons (without the arrival greeting reply) and dispatches while dormant', async () => {
    const h = makeBridge();
    const { ctx, replies } = cmdCtx('mission');

    await h.bridge.handleOwnerCommand(ctx);

    // The kill switch works from dormant: a fresh embodiment is claimed…
    expect(h.connections[0]?.connected).toBe(true);
    expect(h.bridge.isSummoned('u1')).toBe(true);
    // …and the command goes straight to the read-only handler over it.
    expect(h.readOnly).toHaveLength(1);
    expect(h.readOnly[0]!.ctx.command.name).toBe('mission');
    expect(h.readOnly[0]!.connection).toBe(h.connections[0]);
    // No "I'm here" summon reply — the view itself is the reply.
    expect(replies).toEqual([]);
  });

  it('uses the live connection with no re-summon when already embodied', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const { ctx } = cmdCtx('mission');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.connections).toHaveLength(1);
    expect(h.readOnly).toHaveLength(1);
  });

  it('replies with guidance when the dormant summon fails', async () => {
    const h = makeBridge({ outcome: 'superseded' });
    const { ctx, replies } = cmdCtx('mission');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.readOnly).toEqual([]);
    expect(replies[0]).toContain('/summon');
  });

  it('points an unconfigured user at settings instead of summoning', async () => {
    const h = makeBridge({
      overrides: {
        configStore: { ...configStore, findByUserId: async () => null },
      },
    });
    const { ctx, replies } = cmdCtx('mission');

    await h.bridge.handleOwnerCommand(ctx);

    expect(h.connections).toEqual([]);
    expect(replies[0]).toContain('settings');
  });
});
