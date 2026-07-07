import type { DiscordConfigRecord, DiscordConfigStore } from '@cobble/db';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { handleNotifyBotCommand, normalizeSnowflake } from './notify-command.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

const BOT_ID = '111111111111111111';
const CHANNEL_ID = '222222222222222222';

function record(): DiscordConfigRecord {
  return {
    userId: 'u1',
    encryptedBotToken: 'v1.a.b.c',
    boundCompanionId: 'companion-u1',
    ownerDiscordUserId: 'owner-123',
    linkCode: null,
    linkCodeIssuedAt: null,
    triggerBotId: BOT_ID,
    missionChannelId: CHANNEL_ID,
    botUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** A config store whose `configureMissionWake` behaviour each test sets. */
function fakeStore(
  configureMissionWake: DiscordConfigStore['configureMissionWake'],
): DiscordConfigStore {
  return {
    findByUserId: async () => record(),
    list: async () => [record()],
    upsert: async () => record(),
    reissueLinkCode: async () => record(),
    bindOwner: async () => true,
    configureMissionWake,
    setBotUserId: async () => record(),
    delete: async () => {},
  };
}

function cmdCtx(options: Record<string, string>): {
  ctx: SlashCommandContext;
  replies: string[];
} {
  const replies: string[] = [];
  const reply = async (c: string): Promise<void> => {
    replies.push(c);
  };
  return {
    replies,
    ctx: {
      userId: 'u1',
      command: { name: 'notifybot', userId: 'owner-123', channelId: 'dm-1', options, reply },
      reply,
    },
  };
}

describe('normalizeSnowflake', () => {
  it('accepts a bare snowflake', () => {
    expect(normalizeSnowflake(BOT_ID)).toBe(BOT_ID);
    expect(normalizeSnowflake(`  ${BOT_ID}  `)).toBe(BOT_ID);
  });

  it('unwraps user, nickname, role, and channel mentions', () => {
    expect(normalizeSnowflake(`<@${BOT_ID}>`)).toBe(BOT_ID);
    expect(normalizeSnowflake(`<@!${BOT_ID}>`)).toBe(BOT_ID);
    expect(normalizeSnowflake(`<@&${BOT_ID}>`)).toBe(BOT_ID);
    expect(normalizeSnowflake(`<#${CHANNEL_ID}>`)).toBe(CHANNEL_ID);
  });

  it('rejects non-snowflakes', () => {
    expect(normalizeSnowflake('')).toBeNull();
    expect(normalizeSnowflake('not-an-id')).toBeNull();
    expect(normalizeSnowflake('123')).toBeNull(); // too short
    expect(normalizeSnowflake('12345678901234567890123')).toBeNull(); // too long
  });
});

describe('handleNotifyBotCommand', () => {
  it('saves the pair, reconciles the live bot, and confirms', async () => {
    const configure = vi.fn(async () => record());
    const reconcile = vi.fn(async () => {});
    const { ctx, replies } = cmdCtx({ bot: `<@${BOT_ID}>`, channel: `<#${CHANNEL_ID}>` });

    await handleNotifyBotCommand(ctx, fakeStore(configure), reconcile, silent);

    expect(configure).toHaveBeenCalledWith('u1', BOT_ID, CHANNEL_ID);
    expect(reconcile).toHaveBeenCalledWith('u1');
    expect(replies[0]).toContain(BOT_ID);
    expect(replies[0]).toContain(CHANNEL_ID);
    expect(replies[0]).toContain('Set');
  });

  it('rejects a missing or malformed id without writing config', async () => {
    const configure = vi.fn(async () => record());
    const reconcile = vi.fn(async () => {});
    const { ctx, replies } = cmdCtx({ bot: 'nope', channel: CHANNEL_ID });

    await handleNotifyBotCommand(ctx, fakeStore(configure), reconcile, silent);

    expect(configure).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(replies[0]).toContain('/notifybot');
  });

  it('tells the owner to set up a bot token when there is no config row', async () => {
    const reconcile = vi.fn(async () => {});
    const { ctx, replies } = cmdCtx({ bot: BOT_ID, channel: CHANNEL_ID });

    await handleNotifyBotCommand(
      ctx,
      fakeStore(async () => null),
      reconcile,
      silent,
    );

    expect(reconcile).not.toHaveBeenCalled();
    expect(replies[0]).toContain('settings');
  });

  it('still confirms when the config is saved but the live refresh fails', async () => {
    const errors: unknown[] = [];
    const logger: Logger = { ...silent, error: (_m, ctx) => errors.push(ctx) };
    const reconcile = vi.fn(async () => {
      throw new Error('bot not running');
    });
    const { ctx, replies } = cmdCtx({ bot: BOT_ID, channel: CHANNEL_ID });

    await handleNotifyBotCommand(
      ctx,
      fakeStore(async () => record()),
      reconcile,
      logger,
    );

    expect(replies[0]).toContain('Set'); // config persisted → still a success to the owner
    expect(errors).toHaveLength(1);
  });

  it('reports a generic error and does not reconcile when the write throws', async () => {
    const errors: unknown[] = [];
    const logger: Logger = { ...silent, error: (_m, ctx) => errors.push(ctx) };
    const reconcile = vi.fn(async () => {});
    const configure = vi.fn(async () => {
      throw new Error('db down');
    });
    const { ctx, replies } = cmdCtx({ bot: BOT_ID, channel: CHANNEL_ID });

    await handleNotifyBotCommand(ctx, fakeStore(configure), reconcile, logger);

    expect(reconcile).not.toHaveBeenCalled();
    expect(replies[0]).toContain('went wrong');
    expect(errors).toHaveLength(1);
  });
});
