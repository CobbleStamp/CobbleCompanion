import type { MessageDto, MessageRole } from '@cobble/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CompanionEventBus } from '../events/bus.js';
import type { Logger } from '../logging.js';
import { PublishingMemoryStore } from './publishing-store.js';
import type { AppendOptions, MemoryStore, TranscriptEntry } from './store.js';

/** A fake inner store: records append calls and returns a stable DTO. */
class FakeMemoryStore implements MemoryStore {
  appendCalls: Array<{ companionId: string; role: MessageRole; content: string }> = [];
  recentResult: readonly MessageDto[] = [];

  async appendMessage(
    companionId: string,
    role: MessageRole,
    content: string,
    _options?: AppendOptions,
  ): Promise<MessageDto> {
    this.appendCalls.push({ companionId, role, content });
    return {
      id: 'm-persisted',
      companionId,
      role,
      content,
      kind: 'message',
      sourceId: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    };
  }

  async getRecentMessages(): Promise<readonly MessageDto[]> {
    return this.recentResult;
  }

  async getMessagesSince(): Promise<readonly TranscriptEntry[]> {
    return [];
  }

  async countMessages(): Promise<number> {
    return 7;
  }
}

function spyLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

describe('PublishingMemoryStore', () => {
  it('delegates the append to the inner store and returns its DTO', async () => {
    const inner = new FakeMemoryStore();
    const bus: CompanionEventBus = { publish: vi.fn(), subscribe: vi.fn() };
    const store = new PublishingMemoryStore(inner, bus, spyLogger());

    const result = await store.appendMessage('c1', 'user', 'hello');

    expect(inner.appendCalls).toEqual([{ companionId: 'c1', role: 'user', content: 'hello' }]);
    expect(result).toMatchObject({ id: 'm-persisted', content: 'hello' });
  });

  it('publishes the persisted row to the bus after a successful append', async () => {
    const inner = new FakeMemoryStore();
    const publish = vi.fn();
    const bus: CompanionEventBus = { publish, subscribe: vi.fn() };
    const store = new PublishingMemoryStore(inner, bus, spyLogger());

    const result = await store.appendMessage('c1', 'assistant', 'hi there');

    // It publishes the inner store's DTO (with its server id), keyed by companion.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('c1', result);
  });

  it('swallows and logs a bus failure — the append still returns', async () => {
    const inner = new FakeMemoryStore();
    const bus: CompanionEventBus = {
      publish: vi.fn(() => {
        throw new Error('bus exploded');
      }),
      subscribe: vi.fn(),
    };
    const logger = spyLogger();
    const store = new PublishingMemoryStore(inner, bus, logger);

    const result = await store.appendMessage('c1', 'assistant', 'resilient');

    // Persistence is unaffected by a delivery fault...
    expect(result).toMatchObject({ id: 'm-persisted', content: 'resilient' });
    // ...and the failure is logged with debugging context (not silently swallowed).
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls[0]?.[1]).toMatchObject({
      companionId: 'c1',
      messageId: 'm-persisted',
    });
  });

  it('passes reads straight through to the inner store', async () => {
    const inner = new FakeMemoryStore();
    inner.recentResult = [
      {
        id: 'm1',
        companionId: 'c1',
        role: 'user',
        content: 'past',
        kind: 'message',
        sourceId: null,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ];
    const bus: CompanionEventBus = { publish: vi.fn(), subscribe: vi.fn() };
    const store = new PublishingMemoryStore(inner, bus, spyLogger());

    expect(await store.getRecentMessages('c1', 50)).toBe(inner.recentResult);
    expect(await store.countMessages('c1')).toBe(7);
    // Reads never publish.
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
