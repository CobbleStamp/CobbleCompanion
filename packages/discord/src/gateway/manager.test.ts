import type { DiscordConfigRecord, DiscordConfigStore, DiscordConfigUpsert } from '@cobble/db';
import { describe, expect, it, vi } from 'vitest';
import { fakeGatewayFactory } from '../test/fake-gateway.js';
import {
  GatewayManager,
  type DirectMessageContext,
  type GatewayManagerOptions,
  type ProposalActionContext,
  type SlashCommandContext,
} from './manager.js';
import type { Logger } from './types.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/** Minimal in-memory DiscordConfigStore the manager reconciles against. */
class InMemoryConfigStore implements DiscordConfigStore {
  private readonly rows = new Map<string, DiscordConfigRecord>();

  set(record: DiscordConfigRecord): void {
    this.rows.set(record.userId, record);
  }

  remove(userId: string): void {
    this.rows.delete(userId);
  }

  async findByUserId(userId: string): Promise<DiscordConfigRecord | null> {
    return this.rows.get(userId) ?? null;
  }

  async list(): Promise<DiscordConfigRecord[]> {
    return [...this.rows.values()];
  }

  async upsert(input: DiscordConfigUpsert): Promise<DiscordConfigRecord> {
    const record = makeRecord(input.userId, input.encryptedBotToken);
    this.rows.set(record.userId, record);
    return record;
  }

  async reissueLinkCode(userId: string): Promise<DiscordConfigRecord | null> {
    return this.rows.get(userId) ?? null;
  }

  async bindOwner(): Promise<void> {}
  async delete(userId: string): Promise<void> {
    this.rows.delete(userId);
  }
}

function makeRecord(
  userId: string,
  encryptedBotToken: string,
  overrides: Partial<DiscordConfigRecord> = {},
): DiscordConfigRecord {
  return {
    userId,
    encryptedBotToken,
    boundCompanionId: `companion-${userId}`,
    ownerDiscordUserId: null,
    linkCode: null,
    linkCodeIssuedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

// Test decrypt: strips an `enc:` prefix; `bad:` payloads fail to decrypt.
const decryptToken = (encrypted: string): string | null =>
  encrypted.startsWith('bad:') ? null : encrypted.replace(/^enc:/, '');

function makeManager(store: InMemoryConfigStore, overrides: Partial<GatewayManagerOptions> = {}) {
  const gateways = fakeGatewayFactory();
  const received: DirectMessageContext[] = [];
  const commands: SlashCommandContext[] = [];
  const proposalActions: ProposalActionContext[] = [];
  const manager = new GatewayManager({
    configStore: store,
    gatewayFactory: gateways.factory,
    decryptToken,
    onDirectMessage: (ctx) => received.push(ctx),
    onSlashCommand: (ctx) => commands.push(ctx),
    onProposalAction: (ctx) => proposalActions.push(ctx),
    commands: [{ name: 'summon', description: 'Bring the companion here' }],
    pollIntervalMs: 60_000,
    logger: silent,
    ...overrides,
  });
  return { manager, gateways, received, commands, proposalActions };
}

describe('GatewayManager', () => {
  it('starts one bot per config row on sync', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    store.set(makeRecord('u2', 'enc:tokenB'));
    const { manager, gateways } = makeManager(store);

    await manager.sync();

    expect(manager.size).toBe(2);
    expect(gateways.byToken('tokenA')?.started).toBe(true);
    expect(gateways.byToken('tokenB')?.started).toBe(true);
  });

  it('registers the global commands on each started bot', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways } = makeManager(store);

    await manager.sync();

    expect(gateways.byToken('tokenA')?.registeredCommands).toEqual([
      { name: 'summon', description: 'Bring the companion here' },
    ]);
  });

  it('routes an inbound DM to onDirectMessage tagged with the owning user', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways, received } = makeManager(store);
    await manager.sync();

    gateways.byToken('tokenA')!.receiveDirectMessage({
      authorId: 'discord-user-1',
      channelId: 'dm-channel-1',
      content: 'hello cobble',
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.userId).toBe('u1');
    expect(received[0]?.message.content).toBe('hello cobble');
    expect(received[0]?.config.boundCompanionId).toBe('companion-u1');
  });

  it('restarts a bot when its token changes', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways } = makeManager(store);
    await manager.sync();

    // A settings save rewrites the token blob.
    store.set(makeRecord('u1', 'enc:tokenB'));
    await manager.sync();

    expect(gateways.created).toHaveLength(2);
    expect(gateways.byToken('tokenA')?.stopped).toBe(true);
    expect(gateways.byToken('tokenB')?.started).toBe(true);
    expect(manager.size).toBe(1);
  });

  it('does not restart a bot whose config is unchanged', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways } = makeManager(store);
    await manager.sync();
    await manager.sync();

    expect(gateways.created).toHaveLength(1);
    expect(gateways.byToken('tokenA')?.stopped).toBe(false);
  });

  it('stops a bot whose config was removed', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways } = makeManager(store);
    await manager.sync();

    store.remove('u1');
    await manager.sync();

    expect(gateways.byToken('tokenA')?.stopped).toBe(true);
    expect(manager.size).toBe(0);
  });

  it('skips a bot whose token cannot be decrypted', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'bad:cannot-decrypt'));
    const errors: string[] = [];
    const { manager, gateways } = makeManager(store, {
      logger: { error: (m) => errors.push(m), warn: () => {}, info: () => {} },
    });

    await manager.sync();

    expect(manager.size).toBe(0);
    expect(gateways.created).toHaveLength(0);
    expect(errors.some((m) => m.includes('decrypt'))).toBe(true);
  });

  it('start() reconciles then stop() disconnects every bot', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    store.set(makeRecord('u2', 'enc:tokenB'));
    const { manager, gateways } = makeManager(store);

    await manager.start();
    expect(manager.size).toBe(2);

    await manager.stop();
    expect(manager.size).toBe(0);
    expect(gateways.created.every((g) => g.stopped)).toBe(true);
  });

  it('routes a slash command to onSlashCommand tagged with the owning user', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways, commands } = makeManager(store);
    await manager.sync();

    gateways.byToken('tokenA')!.receiveSlashCommand({
      name: 'link',
      userId: 'discord-user-1',
      options: { code: 'ABCD1234' },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.userId).toBe('u1');
    expect(commands[0]?.command.name).toBe('link');
    expect(commands[0]?.command.options.code).toBe('ABCD1234');
  });

  it('a DM context reply sends through the bot gateway', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const { manager, gateways, received } = makeManager(store);
    await manager.sync();

    gateways.byToken('tokenA')!.receiveDirectMessage({
      authorId: 'discord-user-1',
      channelId: 'dm-channel-1',
      content: 'hi',
    });
    await received[0]!.reply('summon me first');

    expect(gateways.byToken('tokenA')?.sent).toEqual([
      { channelId: 'dm-channel-1', content: 'summon me first' },
    ]);
  });

  it('logs and survives a config-store list failure', async () => {
    const store = new InMemoryConfigStore();
    store.set(makeRecord('u1', 'enc:tokenA'));
    const errors: string[] = [];
    const { manager } = makeManager(store, {
      logger: { error: (m) => errors.push(m), warn: () => {}, info: () => {} },
    });
    vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('db down'));

    await expect(manager.sync()).resolves.toBeUndefined();
    expect(manager.size).toBe(0);
    expect(errors.some((m) => m.includes('list config'))).toBe(true);
  });
});
