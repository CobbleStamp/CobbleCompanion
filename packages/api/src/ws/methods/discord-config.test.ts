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
