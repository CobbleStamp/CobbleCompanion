import type { MessageDto, MessageRole } from '@cobble/shared';
import type { CompanionEventBus } from '../events/bus.js';
import type { Logger } from '../logging.js';
import type { AppendOptions, MemoryStore, TranscriptEntry } from './store.js';

/**
 * Wraps a {@link MemoryStore} and publishes each appended row to the
 * {@link CompanionEventBus} (the standing companion event channel, `architecture.md`
 * §6, `implementation.md` §2.4). `appendMessage` is the single chokepoint every
 * persistence path flows through (turn reply, greeting, ingestion announcer,
 * upload turns), so wrapping it here makes every path publish with no call-site
 * change — wired once at the composition root.
 *
 * Publishing is best-effort: a bus fault is logged and swallowed so a delivery
 * hiccup can never fail the append (`common/logging.md`). Reads pass straight
 * through.
 */
export class PublishingMemoryStore implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly bus: CompanionEventBus,
    private readonly logger: Logger,
  ) {}

  async appendMessage(
    companionId: string,
    role: MessageRole,
    content: string,
    options?: AppendOptions,
  ): Promise<MessageDto> {
    const message = await this.inner.appendMessage(companionId, role, content, options);
    try {
      this.bus.publish(companionId, { type: 'message', message });
    } catch (error) {
      this.logger.error('failed to publish appended message to the event bus', {
        operation: 'memory.publishAppend',
        companionId,
        messageId: message.id,
        error,
      });
    }
    return message;
  }

  getRecentMessages(companionId: string, limit: number): Promise<readonly MessageDto[]> {
    return this.inner.getRecentMessages(companionId, limit);
  }

  getMessageById(companionId: string, messageId: string): Promise<MessageDto | null> {
    return this.inner.getMessageById(companionId, messageId);
  }

  getMessagesSince(
    companionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TranscriptEntry[]> {
    return this.inner.getMessagesSince(companionId, afterSeq, limit);
  }

  countMessages(companionId: string): Promise<number> {
    return this.inner.countMessages(companionId);
  }
}
