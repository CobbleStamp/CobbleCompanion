import type { ChatStreamEvent, MessageDto } from '@cobble/shared';
import type { DiscordConfigRecord, DiscordConfigStore, DiscordConfigUpsert } from '@cobble/db';
import { describe, expect, it } from 'vitest';
import type { CompanionConnection, CompanionConnectionFactory } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { fakeGatewayFactory } from './test/fake-gateway.js';
import { assembleService } from './service.js';

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
  async configureMissionWake(): Promise<DiscordConfigRecord | null> {
    return this.recordValue;
  }
  async setBotUserId(): Promise<DiscordConfigRecord | null> {
    return this.recordValue;
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
    async *callStream(): AsyncGenerator<ChatStreamEvent, undefined> {
      // The mission advance path (`mission.advance`): emit one done event so the report
      // is forwarded to the owner DM, letting the trigger chain be asserted end to end.
      yield {
        type: 'done',
        message: { role: 'assistant', content: `report: ${reply}` } as unknown as MessageDto,
      };
    },
    async *greeting(): AsyncIterable<ChatStreamEvent> {},
    async *events(): AsyncIterable<never> {},
  });
}

describe('assembleService (manager → router → bridge → chat)', () => {
  it('drives a linked owner from summon through a chat reply', async () => {
    const config: DiscordConfigRecord = {
      userId: 'u1',
      encryptedBotToken: 'enc:tokenA',
      boundCompanionId: 'companion-u1',
      ownerDiscordUserId: 'owner-1',
      linkCode: null,
      linkCodeIssuedAt: null,
      triggerBotId: null,
      missionChannelId: null,
      botUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const gateways = fakeGatewayFactory();
    const service = assembleService({
      configStore: new OneUserStore(config),
      gatewayFactory: gateways.factory,
      connectionFactory: fakeConnectionFactory('Hello from Cobble.'),
      decryptToken: (encrypted) => encrypted.replace(/^enc:/, ''),
      logger: silent,
    });

    await service.start();
    const bot = gateways.byToken('tokenA');
    expect(bot?.started).toBe(true);

    // Owner summons, then chats.
    bot!.receiveSlashCommand({ name: 'summon', userId: 'owner-1' });
    await flush();
    bot!.receiveDirectMessage({ authorId: 'owner-1', channelId: 'dm-1', content: 'hi' });
    await flush();

    // The chat reply was sent to the DM channel.
    expect(bot?.sent.some((m) => m.content === 'Hello from Cobble.')).toBe(true);
    await service.stop();
  });

  it('refuses a DM from a non-owner (owner lock), sending nothing', async () => {
    const config: DiscordConfigRecord = {
      userId: 'u1',
      encryptedBotToken: 'enc:tokenA',
      boundCompanionId: 'companion-u1',
      ownerDiscordUserId: 'owner-1',
      linkCode: null,
      linkCodeIssuedAt: null,
      triggerBotId: null,
      missionChannelId: null,
      botUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const gateways = fakeGatewayFactory();
    const service = assembleService({
      configStore: new OneUserStore(config),
      gatewayFactory: gateways.factory,
      connectionFactory: fakeConnectionFactory('should not happen'),
      decryptToken: (e) => e.replace(/^enc:/, ''),
      logger: silent,
    });
    await service.start();
    const bot = gateways.byToken('tokenA');

    bot!.receiveDirectMessage({ authorId: 'intruder', channelId: 'dm-1', content: 'let me in' });
    await flush();

    expect(bot?.sent).toHaveLength(0);
    await service.stop();
  });

  it('drives a mission trigger from the channel through summon to an advance report', async () => {
    const config: DiscordConfigRecord = {
      userId: 'u1',
      encryptedBotToken: 'enc:tokenA',
      boundCompanionId: 'companion-u1',
      ownerDiscordUserId: 'owner-1',
      linkCode: null,
      linkCodeIssuedAt: null,
      triggerBotId: 'scheduler-bot',
      missionChannelId: 'mission-chan',
      botUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const gateways = fakeGatewayFactory();
    const service = assembleService({
      configStore: new OneUserStore(config),
      gatewayFactory: gateways.factory,
      connectionFactory: fakeConnectionFactory('LITE holding above 810'),
      decryptToken: (e) => e.replace(/^enc:/, ''),
      logger: silent,
    });
    await service.start();
    const bot = gateways.byToken('tokenA');

    // The scheduler posts a trigger into the mission channel, @-mentioning the bot and
    // naming the mission the wake was armed for (companion-missions.md §3.2).
    bot!.receiveGuildMessage({
      authorId: 'scheduler-bot',
      channelId: 'mission-chan',
      messageId: 'm1',
      content: '<@111> mission:0f4c10ac-9a3e-4b21-8c53-2f6f14be7a90 LITE is 808',
    });
    await flush();

    // Summon-if-dormant opened the owner DM, and the advance report reached it.
    expect(bot?.openedDms).toContain('owner-1');
    expect(bot?.sent.some((m) => m.content === 'report: LITE holding above 810')).toBe(true);
    await service.stop();
  });

  it('ignores a guild message in the wrong channel (no summon, no advance)', async () => {
    const config: DiscordConfigRecord = {
      userId: 'u1',
      encryptedBotToken: 'enc:tokenA',
      boundCompanionId: 'companion-u1',
      ownerDiscordUserId: 'owner-1',
      linkCode: null,
      linkCodeIssuedAt: null,
      triggerBotId: 'scheduler-bot',
      missionChannelId: 'mission-chan',
      botUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const gateways = fakeGatewayFactory();
    const service = assembleService({
      configStore: new OneUserStore(config),
      gatewayFactory: gateways.factory,
      connectionFactory: fakeConnectionFactory('should not happen'),
      decryptToken: (e) => e.replace(/^enc:/, ''),
      logger: silent,
    });
    await service.start();
    const bot = gateways.byToken('tokenA');

    bot!.receiveGuildMessage({
      authorId: 'scheduler-bot',
      channelId: 'some-other-channel',
      messageId: 'm1',
      content: '<@111> wrong room',
    });
    await flush();

    expect(bot?.openedDms).toHaveLength(0);
    expect(bot?.sent).toHaveLength(0);
    await service.stop();
  });
});

/** Let the chained async handlers (router → bridge → chat) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
