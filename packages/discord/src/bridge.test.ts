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

/** The mission id every test trigger names (parsed from the wake by the router). */
const MISSION_ID = '0f4c10ac-9a3e-4b21-8c53-2f6f14be7a90';

/** A connection whose connect outcome and supersession the test drives by hand. */
class FakeConnection implements CompanionConnection {
  connected = false;
  closed = false;
  outcome: 'ok' | 'superseded' = 'ok';
  /** When true, fire the takeover the instant the lease is granted — before the
   * bridge registers the embodiment (the connect→register race). */
  supersedeOnConnect = false;
  /** When set, connect() parks on this gate before granting the lease — drives the
   * slow-handshake races (two establishes overlapping in the connect window). */
  connectGate: Promise<void> | null = null;
  private supersededHandler: () => void = () => {};
  private closedHandler: () => void = () => {};

  async connect(): Promise<void> {
    if (this.connectGate) await this.connectGate;
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
  async *callStream(): AsyncGenerator<never, undefined> {
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
  advances: Array<{
    connection: CompanionConnection;
    missionId: string;
    event: string;
    userId: string;
  }>;
  openedDms: Array<{ userId: string; discordUserId: string }>;
}

function makeBridge(
  opts: {
    outcome?: 'ok' | 'superseded';
    supersedeOnConnect?: boolean;
    /**
     * What the mission-advance hook reports back (default: the mission ran). A
     * predicate decides per-event, so a single race can mix a live mission (not
     * skipped) with a stale one (skipped) over the same user.
     */
    advanceSkipped?: boolean | ((event: string) => boolean);
    /** Configure each connection as the factory mints it (e.g. arm a connect gate). */
    onConnection?: (connection: FakeConnection) => void;
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
      opts.onConnection?.(connection);
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
    onMissionAdvance: async (connection, _post, missionId, event, userId) => {
      advances.push({ connection, missionId, event, userId });
      const skipped =
        typeof opts.advanceSkipped === 'function'
          ? opts.advanceSkipped(event)
          : (opts.advanceSkipped ?? false);
      return { skipped };
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

    await h.bridge.handleTrigger('u1', MISSION_ID, 'LITE is 808');

    expect(h.openedDms).toEqual([{ userId: 'u1', discordUserId: 'owner-123' }]);
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.connections).toHaveLength(1);
    expect(h.advances).toHaveLength(1);
    expect(h.advances[0]?.missionId).toBe(MISSION_ID);
    expect(h.advances[0]?.event).toBe('LITE is 808');
  });

  it('advances over the live connection when already embodied (no re-summon)', async () => {
    const h = makeBridge();
    const { ctx } = cmdCtx('summon');
    await h.bridge.handleOwnerCommand(ctx);
    expect(h.connections).toHaveLength(1);

    await h.bridge.handleTrigger('u1', MISSION_ID, 'threshold crossed');

    // No new connection opened, no owner DM re-opened — reused the live embodiment.
    expect(h.connections).toHaveLength(1);
    expect(h.openedDms).toHaveLength(0);
    expect(h.advances).toHaveLength(1);
    expect(h.advances[0]?.event).toBe('threshold crossed');
  });

  it('tears down a trigger-opened embodiment silently when the advance was skipped', async () => {
    // A stale trigger (the mission is gone — e.g. a wake job whose cancel failed at
    // mission.stop): the summon it caused is undone, with no DM chatter.
    const h = makeBridge({ advanceSkipped: true });

    await h.bridge.handleTrigger('u1', MISSION_ID, 'LITE is 808');

    expect(h.advances).toHaveLength(1); // the server was asked (it owns the validity check)
    expect(h.bridge.isSummoned('u1')).toBe(false); // …but the claim was not kept
    expect(h.connections[0]?.closed).toBe(true);
    expect(h.notices).toHaveLength(0); // silent: the owner never asked for this embodiment
  });

  it('keeps a user-summoned embodiment when a stale trigger is skipped over it', async () => {
    const h = makeBridge({ advanceSkipped: true });
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);

    await h.bridge.handleTrigger('u1', MISSION_ID, 'LITE is 808');

    expect(h.advances).toHaveLength(1);
    expect(h.bridge.isSummoned('u1')).toBe(true); // the owner's summon is theirs to keep
    expect(h.connections[0]?.closed).toBe(false);
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

    await h.bridge.handleTrigger('u1', MISSION_ID, 'event');

    expect(h.bridge.isSummoned('u1')).toBe(false);
    expect(h.advances).toHaveLength(0);
    expect(h.openedDms).toHaveLength(0);
  });
});

/** Flush pending microtasks (and one macrotask turn) so in-flight async chains advance. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('CompanionBridge — embodiment races', () => {
  it('ignores a late supersede from a torn-down connection (successor stays live)', async () => {
    const h = makeBridge();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx);
    const first = h.connections[0]!;
    first.triggerClosed(); // socket drops → teardown
    await Promise.resolve();
    await h.bridge.handleOwnerCommand(cmdCtx('summon').ctx); // re-summon → connection #2
    expect(h.bridge.isSummoned('u1')).toBe(true);
    h.notices.length = 0;

    // A late supersede event arrives from the already-torn-down first connection.
    first.triggerSuperseded();
    await Promise.resolve();

    // The successor embodiment must survive: no teardown, no spurious "stepped over" DM.
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.connections[1]?.closed).toBe(false);
    expect(h.notices).toHaveLength(0);
  });

  it('serializes two triggers under a slow connect: one connection, both advance', async () => {
    const gates: Array<() => void> = [];
    const h = makeBridge({
      onConnection: (connection) => {
        connection.connectGate = new Promise((resolve) => gates.push(resolve));
      },
    });

    // Two trigger firings faster than the WS handshake (an `--every 1s` job whose
    // connect takes longer than its interval).
    const first = h.bridge.handleTrigger('u1', MISSION_ID, 'tick 1');
    const second = h.bridge.handleTrigger('u1', MISSION_ID, 'tick 2');
    await tick(); // both past their dormant checks; the first parked in connect()
    // The second establish must queue behind the first, not dial a second connection
    // (whose claim would supersede — and whose event would tear down — the first).
    expect(gates).toHaveLength(1);
    for (const release of gates) release();
    await Promise.all([first, second]);

    expect(h.connections).toHaveLength(1);
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.advances).toHaveLength(2);
    expect(h.advances.every((a) => a.connection === h.connections[0])).toBe(true);
    expect(h.notices).toHaveLength(0); // no teardown thrash, no spurious DM
  });

  it('does not tear down a live active-mission embodiment when a concurrent stale trigger is skipped over it', async () => {
    const gates: Array<() => void> = [];
    const h = makeBridge({
      // The first wake's mission is live (not skipped); the second is stale (skipped).
      advanceSkipped: (event) => event === 'stale',
      onConnection: (connection) => {
        connection.connectGate = new Promise((resolve) => gates.push(resolve));
      },
    });

    // Two mission wakes race from dormant: 'active' opens the embodiment first, and
    // 'stale' queues behind it — reusing the same connection rather than dialing its own.
    const active = h.bridge.handleTrigger('u1', MISSION_ID, 'active');
    const stale = h.bridge.handleTrigger('u1', MISSION_ID, 'stale');
    await tick(); // both past their dormant checks; the first parked in connect()
    expect(gates).toHaveLength(1); // serialized: only the first dialed
    for (const release of gates) release();
    await Promise.all([active, stale]);

    expect(h.connections).toHaveLength(1); // the stale wake reused, it did not dial
    expect(h.advances).toHaveLength(2); // both missions were advanced over the one connection
    // The stale wake merely reused a connection the active wake opened — it must not tear
    // it down. The active mission's embodiment has to stay live.
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.connections[0]?.closed).toBe(false);
    expect(h.notices).toHaveLength(0);
  });

  it('does not retract when the stale wake opened the connection a live wake reused', async () => {
    // The reverse ordering of the test above: the STALE wake wins the connect and OPENS the
    // connection; the LIVE wake queues behind it and reuses that same connection. The stale
    // wake's skip must not close a connection the live wake is still advancing over — the
    // retract has to wait for the last concurrent wake and stand down because one was live.
    // Both advances are gated so the two wakes are provably in flight together (both holding
    // the connection) at the moment the stale one is released and would, on the bug, tear down.
    const connectGates: Array<() => void> = [];
    const advanceGates = new Map<string, () => void>();
    const gateFor = (event: string): Promise<void> =>
      new Promise((resolve) => advanceGates.set(event, resolve));
    const advanced: string[] = [];
    const h = makeBridge({
      onConnection: (connection) => {
        connection.connectGate = new Promise((resolve) => connectGates.push(resolve));
      },
      overrides: {
        onMissionAdvance: async (_connection, _post, _missionId, event) => {
          advanced.push(event);
          await gateFor(event);
          return { skipped: event === 'stale' };
        },
      },
    });

    const stale = h.bridge.handleTrigger('u1', MISSION_ID, 'stale');
    const active = h.bridge.handleTrigger('u1', MISSION_ID, 'active');
    await tick(); // both past their dormant checks; the stale wake parked in connect()
    expect(connectGates).toHaveLength(1); // serialized: only the first (stale) dialed
    connectGates[0]!();
    await tick(); // stale registers; both wakes now parked in advance over the one connection
    expect(advanced).toEqual(['stale', 'active']);
    expect(h.bridge.isSummoned('u1')).toBe(true);

    // Release the STALE advance first: its skip must NOT retract — the live wake still holds.
    advanceGates.get('stale')!();
    await tick();
    expect(h.bridge.isSummoned('u1')).toBe(true); // the live wake's embodiment survives
    expect(h.connections[0]?.closed).toBe(false);

    advanceGates.get('active')!();
    await Promise.all([stale, active]);
    expect(h.connections).toHaveLength(1); // the live wake reused, it did not dial
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.notices).toHaveLength(0); // no teardown, no spurious DM
  });

  it('retracts a stale-only trigger race once the last concurrent wake finishes', async () => {
    // Both wakes are stale (a recurring wake firing twice after the mission is gone). Neither
    // justifies the embodiment, so it must be retracted exactly once — by the last wake out,
    // not left squatting (the leak a naive "only the opener tears down" guard would allow).
    const connectGates: Array<() => void> = [];
    const advanceGates = new Map<string, () => void>();
    const gateFor = (event: string): Promise<void> =>
      new Promise((resolve) => advanceGates.set(event, resolve));
    const h = makeBridge({
      onConnection: (connection) => {
        connection.connectGate = new Promise((resolve) => connectGates.push(resolve));
      },
      overrides: {
        onMissionAdvance: async (_connection, _post, _missionId, event) => {
          await gateFor(event);
          return { skipped: true };
        },
      },
    });

    const first = h.bridge.handleTrigger('u1', MISSION_ID, 'stale-a');
    const second = h.bridge.handleTrigger('u1', MISSION_ID, 'stale-b');
    await tick();
    connectGates[0]!();
    await tick(); // both parked in advance over the one connection (holders = 2)

    // First wake out: it is NOT the last holder, so it must not retract yet.
    advanceGates.get('stale-a')!();
    await tick();
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.connections[0]?.closed).toBe(false);

    // Last wake out: no advance was ever live, so it retracts the embodiment silently.
    advanceGates.get('stale-b')!();
    await Promise.all([first, second]);
    expect(h.bridge.isSummoned('u1')).toBe(false);
    expect(h.connections[0]?.closed).toBe(true);
    expect(h.notices).toHaveLength(0);
  });

  it('does not silently retract when a trigger advance throws (left to close handlers)', async () => {
    // A mid-turn connection drop / server error surfaces as a thrown advance, not a skip.
    // The retract must fire only on a genuine skip — a throw is left to the connection's own
    // close/supersede handlers (which carry a notice), not raced by a silent teardown here.
    const h = makeBridge({
      overrides: {
        onMissionAdvance: async () => {
          throw new Error('mid-turn connection drop');
        },
      },
    });

    await expect(h.bridge.handleTrigger('u1', MISSION_ID, 'boom')).rejects.toThrow(
      'mid-turn connection drop',
    );

    // The embodiment is NOT torn down by the retract path: holders balanced back to 0 but the
    // advance never skipped, so the connection stays for the close handler to reap.
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.connections[0]?.closed).toBe(false);
    expect(h.notices).toHaveLength(0);
  });

  it('a /summon racing a trigger reuses the in-flight embodiment (no second dial)', async () => {
    const gates: Array<() => void> = [];
    const h = makeBridge({
      onConnection: (connection) => {
        connection.connectGate = new Promise((resolve) => gates.push(resolve));
      },
    });

    const trigger = h.bridge.handleTrigger('u1', MISSION_ID, 'threshold crossed');
    await tick(); // the trigger's connect is in flight
    const { ctx, replies } = cmdCtx('summon');
    const summon = h.bridge.handleOwnerCommand(ctx);
    await tick();
    for (const release of gates) release();
    await Promise.all([trigger, summon]);

    expect(h.connections).toHaveLength(1);
    expect(h.bridge.isSummoned('u1')).toBe(true);
    expect(h.advances).toHaveLength(1);
    expect(replies[0]).toContain('here');
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
