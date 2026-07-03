import type { DiscordConfigRecord } from '@cobble/db';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../app.js';
import type { WsCallContext } from '../dispatch.js';
import { discordConfigMethods } from './discord-config.js';

/**
 * Unit-tests the reconcile-trigger wiring (companion-discord.md §2.1): a token save and
 * a delete fire `discordReconcile`; the read-only methods do not. Calls the method table
 * directly with a minimal fake deps (no WS harness needed).
 */

function record(overrides: Partial<DiscordConfigRecord> = {}): DiscordConfigRecord {
  return {
    userId: 'user-1',
    encryptedBotToken: 'enc',
    boundCompanionId: 'c1',
    ownerDiscordUserId: null,
    linkCode: 'ABCD2345',
    linkCodeIssuedAt: new Date(0),
    triggerBotId: null,
    missionChannelId: null,
    botUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeDeps(reconcile: (userId: string) => Promise<void>): AppDeps {
  return {
    discordConfig: {
      findByUserId: async () => record(),
      list: async () => [record()],
      upsert: async () => record(),
      reissueLinkCode: async () => record(),
      bindOwner: async () => true,
      configureMissionWake: async () => record(),
      delete: async () => {},
    },
    identity: { getCompanion: async () => ({ id: 'c1' }) },
    config: { discordTokenKey: Buffer.alloc(32, 7).toString('base64') },
    discordReconcile: reconcile,
  } as unknown as AppDeps;
}

const ctx = { userId: 'user-1' } as unknown as WsCallContext;

describe('discordConfigMethods — reconcile trigger', () => {
  it('fires discordReconcile after a token save (discord.config.set)', async () => {
    const reconcile = vi.fn(async () => {});
    const methods = discordConfigMethods(makeDeps(reconcile));

    await methods['discord.config.set']!(ctx, { botToken: 'tok', boundCompanionId: 'c1' });

    expect(reconcile).toHaveBeenCalledWith('user-1');
  });

  it('fires discordReconcile after a delete (discord.config.delete)', async () => {
    const reconcile = vi.fn(async () => {});
    const methods = discordConfigMethods(makeDeps(reconcile));

    await methods['discord.config.delete']!(ctx, {});

    expect(reconcile).toHaveBeenCalledWith('user-1');
  });

  it('does NOT fire discordReconcile on the read-only get / regenerate methods', async () => {
    const reconcile = vi.fn(async () => {});
    const methods = discordConfigMethods(makeDeps(reconcile));

    await methods['discord.config.get']!(ctx, {});
    await methods['discord.config.regenerateLink']!(ctx, {});

    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('discordConfigMethods — mission wake', () => {
  function makeWakeDeps(
    configureMissionWake: (
      userId: string,
      triggerBotId: string | null,
      missionChannelId: string | null,
    ) => Promise<DiscordConfigRecord | null>,
    discordTokenKey = Buffer.alloc(32, 7).toString('base64'),
    discordReconcile: (userId: string) => Promise<void> = async () => {},
  ): AppDeps {
    return {
      discordConfig: {
        findByUserId: async () => record(),
        list: async () => [record()],
        upsert: async () => record(),
        reissueLinkCode: async () => record(),
        bindOwner: async () => true,
        configureMissionWake,
        delete: async () => {},
      },
      config: { discordTokenKey },
      discordReconcile,
    } as unknown as AppDeps;
  }

  // Valid Discord snowflakes (17–20 digits, per discordMissionWakeSchema).
  const TRIGGER_BOT_ID = '111111111111111111';
  const MISSION_CHANNEL_ID = '222222222222222222';

  it('persists the trigger bot id + mission channel id', async () => {
    const spy = vi.fn(async () => record());
    const methods = discordConfigMethods(makeWakeDeps(spy));

    const result = await methods['discord.config.setMissionWake']!(ctx, {
      triggerBotId: TRIGGER_BOT_ID,
      missionChannelId: MISSION_CHANNEL_ID,
    });

    expect(spy).toHaveBeenCalledWith('user-1', TRIGGER_BOT_ID, MISSION_CHANNEL_ID);
    expect(result).toHaveProperty('discord.configured', true);
  });

  it('fires discordReconcile so the running bot refreshes its trust snapshot', async () => {
    const reconcile = vi.fn(async () => {});
    const methods = discordConfigMethods(makeWakeDeps(async () => record(), undefined, reconcile));

    await methods['discord.config.setMissionWake']!(ctx, {
      triggerBotId: TRIGGER_BOT_ID,
      missionChannelId: MISSION_CHANNEL_ID,
    });

    expect(reconcile).toHaveBeenCalledWith('user-1');
  });

  it('does NOT fire discordReconcile when persistence returns no config row', async () => {
    const reconcile = vi.fn(async () => {});
    const methods = discordConfigMethods(makeWakeDeps(async () => null, undefined, reconcile));

    await expect(
      methods['discord.config.setMissionWake']!(ctx, {
        triggerBotId: TRIGGER_BOT_ID,
        missionChannelId: MISSION_CHANNEL_ID,
      }),
    ).rejects.toThrow(/no Discord config/);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects non-numeric ids (bad_params before touching the store)', async () => {
    const spy = vi.fn(async () => record());
    const methods = discordConfigMethods(makeWakeDeps(spy));

    await expect(
      methods['discord.config.setMissionWake']!(ctx, {
        triggerBotId: 'not-a-snowflake',
        missionChannelId: '222',
      }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a conflict when Discord is not configured on the server (no key)', async () => {
    const spy = vi.fn(async () => record());
    const methods = discordConfigMethods(makeWakeDeps(spy, ''));

    await expect(
      methods['discord.config.setMissionWake']!(ctx, { triggerBotId: '1', missionChannelId: '2' }),
    ).rejects.toThrow(/not available/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a not-found when the user has no Discord config row', async () => {
    const methods = discordConfigMethods(makeWakeDeps(async () => null));

    await expect(
      methods['discord.config.setMissionWake']!(ctx, {
        triggerBotId: TRIGGER_BOT_ID,
        missionChannelId: MISSION_CHANNEL_ID,
      }),
    ).rejects.toThrow(/no Discord config/);
  });
});
