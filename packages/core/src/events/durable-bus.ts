/**
 * Durable companion event bus (deliver-scalability.md §6 D4). The production
 * {@link CompanionEventBus}: every publish appends to the durable
 * {@link CompanionEventLog}, so any node's WS embodiment connection can read the
 * event by cursor and deliver it cross-node. There is no in-process fan-out — the
 * log is the single delivery substrate (the SSE in-process bus was removed with the
 * HTTP surface).
 */

import type { CompanionStreamEvent } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { CompanionEventBus } from './bus.js';
import type { CompanionEventLog } from './log.js';

export class DurableCompanionEventBus implements CompanionEventBus {
  constructor(
    private readonly log: CompanionEventLog,
    private readonly logger: Logger,
  ) {}

  publish(companionId: string, event: CompanionStreamEvent): void {
    // Durable append, fire-and-forget — a log hiccup must never break the
    // persistence path that called publish (logging.md).
    void this.log.append(companionId, event).catch((error: unknown) =>
      this.logger.error('failed to append companion event to the durable log', {
        operation: 'events.durableBus.append',
        companionId,
        error,
      }),
    );
  }
}
