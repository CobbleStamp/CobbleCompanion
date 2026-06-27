import type { ChatStreamEvent, MessageDto } from '@cobble/shared';
import type { DiscordConfigRecord, DiscordConfigStore, DiscordConfigUpsert } from '@cobble/db';
import { describe, expect, it } from 'vitest';
import type { CompanionConnection, CompanionConnectionFactory } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { fakeGatewayFactory } from './test/fake-gateway.js';
import { assembleWorker } from './worker.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

class OneUserStore implements DiscordConfigStore {
  constructor(private readonly recordValue: DiscordConfigRecord) {}
  async findByUserId(userId: string): Promise<DiscordConfigRecord | null> {
    return userId === this.recordValue.userId ? this.recordValue : null;
  }
  async list(): Promise<DiscordConfigRecord[]> {
    return [this.recordValue];
  }
  async upsert(_input: DiscordConfigUpsert): Promise<DiscordConfigRecord> {
    return this.recordValue;
  }
  async reissueLinkCode(): Promise<DiscordConfigRecord | null> {
    return this.recordValue;
  }
  async bindOwner(): Promise<boolean> {
    return true;
  }
  async delete(): Promise<void> {}
}

/** A connection whose chat() replays one done event. */
function fakeConnectionFactory(reply: string): CompanionConnectionFactory {
  return (): CompanionConnection => ({
    connect: async () => {},
    onSuperseded: () => {},
    onClosed: () => {},
    close: () => {},
    call: <T>(): Promise<T> => Promise.reject(new Error('call() not used in this test')),
    async *chat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'composing' };
      yield {
        type: 'done',
        message: { role: 'assistant', content: reply } as unknown as MessageDto,
      };
    },
    async *callStream(): AsyncIterable<ChatStreamEvent> {
      // Not used in this test (chat() is the streaming path).
    },
    async *greeting(): AsyncIterable<ChatStreamEvent> {},
    async *events(): AsyncIterable<never> {},
  });
}

describe('assembleWorker (manager → router → bridge → chat)', () => {
  it('drives a linked owner from summon through a chat reply', async () => {
    const config: DiscordConfigRecord = {
      userId: 'u1',
      encryptedBotToken: 'enc:tokenA',
      boundCompanionId: 'companion-u1',
      ownerDiscordUserId: 'owner-1',
      linkCode: null,
      linkCodeIssuedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const gateways = fakeGatewayFactory();
    const worker = assembleWorker({
      configStore: new OneUserStore(config),
      gatewayFactory: gateways.factory,
      connectionFactory: fakeConnectionFactory('Hello from Cobble.'),
      decryptToken: (encrypted) => encrypted.replace(/^enc:/, ''),
      pollIntervalMs: 60_000,
      logger: silent,
    });

    await worker.start();
    const bot = gateways.byToken('tokenA');
    expect(bot?.started).toBe(true);

    // Owner summons, then chats.
    bot!.receiveSlashCommand({ name: 'summon', userId: 'owner-1' });
    await flush();
    bot!.receiveDirectMessage({ authorId: 'owner-1', channelId: 'dm-1', content: 'hi' });
    await flush();

    // The chat reply was sent to the DM channel.
    expect(bot?.sent.some((m) => m.content === 'Hello from Cobble.')).toBe(true);
    await worker.stop();
  });

  it('refuses a DM from a non-owner (owner lock), sending nothing', async () => {
    const config: DiscordConfigRecord = {
      userId: 'u1',
      encryptedBotToken: 'enc:tokenA',
      boundCompanionId: 'companion-u1',
      ownerDiscordUserId: 'owner-1',
      linkCode: null,
      linkCodeIssuedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const gateways = fakeGatewayFactory();
    const worker = assembleWorker({
      configStore: new OneUserStore(config),
      gatewayFactory: gateways.factory,
      connectionFactory: fakeConnectionFactory('should not happen'),
      decryptToken: (e) => e.replace(/^enc:/, ''),
      pollIntervalMs: 60_000,
      logger: silent,
    });
    await worker.start();
    const bot = gateways.byToken('tokenA');

    bot!.receiveDirectMessage({ authorId: 'intruder', channelId: 'dm-1', content: 'let me in' });
    await flush();

    expect(bot?.sent).toHaveLength(0);
    await worker.stop();
  });
});

/** Let the chained async handlers (router → bridge → chat) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
