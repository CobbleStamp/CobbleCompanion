import type { DiscordConfigRecord, DiscordConfigStore, DiscordConfigUpsert } from '@cobble/db';
import { describe, expect, it } from 'vitest';
import type { DirectMessageContext, SlashCommandContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { BotRouter } from './router.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const NOW = new Date('2026-06-26T12:00:00Z').getTime();

/** In-memory config store for one user; tracks bindOwner for assertions. */
class OneUserStore implements DiscordConfigStore {
  constructor(private record: DiscordConfigRecord) {}
  boundTo: string | null = null;

  async findByUserId(userId: string): Promise<DiscordConfigRecord | null> {
    return userId === this.record.userId ? this.record : null;
  }
  async list(): Promise<DiscordConfigRecord[]> {
    return [this.record];
  }
  async upsert(_input: DiscordConfigUpsert): Promise<DiscordConfigRecord> {
    return this.record;
  }
  async reissueLinkCode(): Promise<DiscordConfigRecord | null> {
    return this.record;
  }
  async bindOwner(
    userId: string,
    ownerDiscordUserId: string,
    expectedLinkCode: string,
  ): Promise<boolean> {
    // Mirror the store's atomic guard: bind only if the code is unconsumed and matches.
    if (userId !== this.record.userId) return false;
    if (this.record.linkCode === null || this.record.linkCode !== expectedLinkCode) {
      return false;
    }
    this.boundTo = ownerDiscordUserId;
    this.record = { ...this.record, ownerDiscordUserId, linkCode: null, linkCodeIssuedAt: null };
    return true;
  }
  async configureMissionWake(
    _userId: string,
    triggerBotId: string | null,
    missionChannelId: string | null,
  ): Promise<DiscordConfigRecord | null> {
    this.record = { ...this.record, triggerBotId, missionChannelId };
    return this.record;
  }
  async delete(): Promise<void> {}
}

function record(overrides: Partial<DiscordConfigRecord> = {}): DiscordConfigRecord {
  return {
    userId: 'u1',
    encryptedBotToken: 'v1.a.b.c',
    boundCompanionId: 'companion-u1',
    ownerDiscordUserId: null,
    linkCode: null,
    linkCodeIssuedAt: null,
    triggerBotId: null,
    missionChannelId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function dmCtx(
  config: DiscordConfigRecord,
  authorId: string,
  content: string,
): { ctx: DirectMessageContext; replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      userId: config.userId,
      message: { authorId, channelId: 'dm-1', content },
      reply: async (c) => {
        replies.push(c);
      },
      typing: async () => {},
      sendProposal: async () => {},
    },
  };
}

function cmdCtx(
  config: DiscordConfigRecord,
  name: string,
  invokerId: string,
  options: Record<string, string> = {},
): { ctx: SlashCommandContext; replies: string[] } {
  const replies: string[] = [];
  const reply = async (c: string): Promise<void> => {
    replies.push(c);
  };
  return {
    replies,
    ctx: {
      userId: config.userId,
      command: { name, userId: invokerId, channelId: 'dm-1', options, reply },
      reply,
    },
  };
}

function makeRouter(store: DiscordConfigStore) {
  const ownerMessages: DirectMessageContext[] = [];
  const ownerCommands: SlashCommandContext[] = [];
  const triggers: { userId: string; event: string }[] = [];
  const router = new BotRouter({
    configStore: store,
    onOwnerMessage: (ctx) => {
      ownerMessages.push(ctx);
    },
    onOwnerCommand: (ctx) => {
      ownerCommands.push(ctx);
    },
    onTrigger: (userId, event) => {
      triggers.push({ userId, event });
    },
    now: () => NOW,
    logger: silent,
  });
  return { router, ownerMessages, ownerCommands, triggers };
}

describe('BotRouter — owner lock (DMs)', () => {
  it('prompts /link for a DM before the bot is linked', async () => {
    const config = record({ ownerDiscordUserId: null });
    const { router, ownerMessages } = makeRouter(new OneUserStore(config));
    const { ctx, replies } = dmCtx(config, 'anyone', 'hello');

    await router.handleDirectMessage(ctx);

    expect(replies[0]).toContain('/link');
    expect(ownerMessages).toHaveLength(0);
  });

  it('silently ignores a DM from a non-owner once linked', async () => {
    const config = record({ ownerDiscordUserId: 'owner-123' });
    const { router, ownerMessages } = makeRouter(new OneUserStore(config));
    const { ctx, replies } = dmCtx(config, 'intruder-999', 'let me in');

    await router.handleDirectMessage(ctx);

    expect(replies).toHaveLength(0);
    expect(ownerMessages).toHaveLength(0);
  });

  it('passes an owner DM to onOwnerMessage', async () => {
    const config = record({ ownerDiscordUserId: 'owner-123' });
    const { router, ownerMessages } = makeRouter(new OneUserStore(config));
    const { ctx } = dmCtx(config, 'owner-123', 'hi cobble');

    await router.handleDirectMessage(ctx);

    expect(ownerMessages).toHaveLength(1);
    expect(ownerMessages[0]?.message.content).toBe('hi cobble');
  });

  it('reads the owner from the store on demand — recognizes a just-linked owner (DM)', async () => {
    // The context carries no config snapshot (companion-discord.md §2.1); the router
    // reads the store at handling time, so an owner bound by a `/link` moments earlier
    // is seen immediately — no poll/cache lag (the bug this design removes).
    const linked = record({ ownerDiscordUserId: 'owner-123' });
    const { router, ownerMessages } = makeRouter(new OneUserStore(linked));
    const { ctx, replies } = dmCtx(record({ ownerDiscordUserId: null }), 'owner-123', 'hi cobble');

    await router.handleDirectMessage(ctx);

    expect(replies).toHaveLength(0);
    expect(ownerMessages).toHaveLength(1);
  });
});

describe('BotRouter — /link handshake', () => {
  it('binds the invoker as owner on a valid, unexpired code', async () => {
    const config = record({
      linkCode: 'GOODCODE',
      linkCodeIssuedAt: new Date(NOW - 60_000),
    });
    const store = new OneUserStore(config);
    const { router } = makeRouter(store);
    const { ctx, replies } = cmdCtx(config, 'link', 'owner-123', { code: 'GOODCODE' });

    await router.handleSlashCommand(ctx);

    expect(store.boundTo).toBe('owner-123');
    expect(replies[0]).toContain('Linked');
  });

  it('rejects a wrong code without binding', async () => {
    const config = record({ linkCode: 'GOODCODE', linkCodeIssuedAt: new Date(NOW - 60_000) });
    const store = new OneUserStore(config);
    const { router } = makeRouter(store);
    const { ctx, replies } = cmdCtx(config, 'link', 'owner-123', { code: 'WRONG' });

    await router.handleSlashCommand(ctx);

    expect(store.boundTo).toBeNull();
    expect(replies[0]).toContain('didn’t match');
  });

  it('rejects an expired code', async () => {
    const config = record({
      linkCode: 'GOODCODE',
      linkCodeIssuedAt: new Date(NOW - 20 * 60_000), // 20 min ago > 15 min TTL
    });
    const store = new OneUserStore(config);
    const { router } = makeRouter(store);
    const { ctx, replies } = cmdCtx(config, 'link', 'owner-123', { code: 'GOODCODE' });

    await router.handleSlashCommand(ctx);

    expect(store.boundTo).toBeNull();
    expect(replies[0]).toContain('expired');
  });

  it('reports no pending link when there is no code', async () => {
    const config = record({ linkCode: null });
    const { router } = makeRouter(new OneUserStore(config));
    const { ctx, replies } = cmdCtx(config, 'link', 'owner-123', { code: 'anything' });

    await router.handleSlashCommand(ctx);

    expect(replies[0]).toContain('No pending link');
  });

  it('tells the loser of a concurrent /link race the code was just used', async () => {
    // The race: this caller reads a still-valid code and passes the router's checks,
    // but a concurrent /link already consumed it, so the atomic bindOwner returns false.
    const config = record({ linkCode: 'GOODCODE', linkCodeIssuedAt: new Date(NOW - 60_000) });
    const store = new OneUserStore(config);
    store.bindOwner = async () => false;
    const { router } = makeRouter(store);
    const { ctx, replies } = cmdCtx(config, 'link', 'attacker-999', { code: 'GOODCODE' });

    await router.handleSlashCommand(ctx);

    expect(store.boundTo).toBeNull();
    expect(replies[0]).toContain('just used');
  });
});

describe('BotRouter — owner lock (commands)', () => {
  it('prompts to link a non-/link command before linking', async () => {
    const config = record({ ownerDiscordUserId: null });
    const { router, ownerCommands } = makeRouter(new OneUserStore(config));
    const { ctx, replies } = cmdCtx(config, 'summon', 'owner-123');

    await router.handleSlashCommand(ctx);

    expect(replies[0]).toContain('Link this companion first');
    expect(ownerCommands).toHaveLength(0);
  });

  it('refuses a non-owner command once linked', async () => {
    const config = record({ ownerDiscordUserId: 'owner-123' });
    const { router, ownerCommands } = makeRouter(new OneUserStore(config));
    const { ctx, replies } = cmdCtx(config, 'summon', 'intruder-999');

    await router.handleSlashCommand(ctx);

    expect(replies[0]).toContain('only responds to its owner');
    expect(ownerCommands).toHaveLength(0);
  });

  it('passes an owner command to onOwnerCommand', async () => {
    const config = record({ ownerDiscordUserId: 'owner-123' });
    const { router, ownerCommands } = makeRouter(new OneUserStore(config));
    const { ctx } = cmdCtx(config, 'summon', 'owner-123');

    await router.handleSlashCommand(ctx);

    expect(ownerCommands).toHaveLength(1);
    expect(ownerCommands[0]?.command.name).toBe('summon');
  });

  it('reads the owner from the store on demand — /summon right after /link works', async () => {
    // The original "/link then /summon" bug: the bind persisted but the manager's
    // cached config lagged, so /summon was refused "link this first". With on-demand
    // reads (companion-discord.md §2.1) the router reads the store at handling time, so
    // the just-linked owner is recognized at once — no poll window.
    const linked = record({ ownerDiscordUserId: 'owner-123' });
    const { router, ownerCommands } = makeRouter(new OneUserStore(linked));
    const { ctx, replies } = cmdCtx(record({ ownerDiscordUserId: null }), 'summon', 'owner-123');

    await router.handleSlashCommand(ctx);

    expect(replies).toHaveLength(0);
    expect(ownerCommands).toHaveLength(1);
    expect(ownerCommands[0]?.command.name).toBe('summon');
  });
});

describe('BotRouter — mission trigger (guild) trust gate', () => {
  const TRIGGER_BOT = 'scheduler-bot-1';
  const MISSION_CHANNEL = 'mission-chan-1';

  function guildCtx(input: {
    userId?: string;
    authorId: string;
    channelId: string;
    content: string;
  }) {
    return {
      userId: input.userId ?? 'u1',
      message: {
        authorId: input.authorId,
        channelId: input.channelId,
        messageId: 'msg-1',
        content: input.content,
      },
    };
  }

  const configured = (): OneUserStore =>
    new OneUserStore(record({ triggerBotId: TRIGGER_BOT, missionChannelId: MISSION_CHANNEL }));

  it('fires onTrigger for an allowlisted sender in the mission channel', async () => {
    const { router, triggers } = makeRouter(configured());
    await router.handleGuildTrigger(
      guildCtx({
        authorId: TRIGGER_BOT,
        channelId: MISSION_CHANNEL,
        content: '<@111> LITE is 808',
      }),
    );
    expect(triggers).toEqual([{ userId: 'u1', event: 'LITE is 808' }]);
  });

  it('drops a message from a non-allowlisted author', async () => {
    const { router, triggers } = makeRouter(configured());
    await router.handleGuildTrigger(
      guildCtx({ authorId: 'someone-else', channelId: MISSION_CHANNEL, content: '<@bot> spoof' }),
    );
    expect(triggers).toHaveLength(0);
  });

  it('drops a message in the wrong channel even from the trigger bot', async () => {
    const { router, triggers } = makeRouter(configured());
    await router.handleGuildTrigger(
      guildCtx({ authorId: TRIGGER_BOT, channelId: 'other-chan', content: '<@bot> wrong room' }),
    );
    expect(triggers).toHaveLength(0);
  });

  it('drops when the mission wake is not configured', async () => {
    const { router, triggers } = makeRouter(new OneUserStore(record()));
    await router.handleGuildTrigger(
      guildCtx({ authorId: TRIGGER_BOT, channelId: MISSION_CHANNEL, content: '<@bot> event' }),
    );
    expect(triggers).toHaveLength(0);
  });

  it('drops a mention-only trigger with no event text', async () => {
    const { router, triggers } = makeRouter(configured());
    await router.handleGuildTrigger(
      guildCtx({ authorId: TRIGGER_BOT, channelId: MISSION_CHANNEL, content: '<@111>' }),
    );
    expect(triggers).toHaveLength(0);
  });
});
