/**
 * Durable companion event bus (deliver-scalability.md §6 D4). A drop-in
 * {@link CompanionEventBus} that, on publish, BOTH appends to the durable
 * {@link CompanionEventLog} (so any node's embodiment connection can read the event
 * cross-node) AND fans to an inner in-process bus (so same-node SSE subscribers keep
 * working through the transition). When SSE is removed (the final cleanup), the
 * inner bus goes with it and the log stands alone.
 */

import type { CompanionStreamEvent } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { CompanionEventBus, CompanionSubscription } from './bus.js';
import type { CompanionEventLog } from './log.js';

export class DurableCompanionEventBus implements CompanionEventBus {
  constructor(
    private readonly inner: CompanionEventBus,
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
    this.inner.publish(companionId, event);
  }

  subscribe(companionId: string): CompanionSubscription {
    return this.inner.subscribe(companionId);
  }
}
