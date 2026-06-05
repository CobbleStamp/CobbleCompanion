/**
 * In-process motivation runner — keeps proactive ticks OFF the request path
 * (mirrors the consolidation runner). A turn finishes or a heartbeat arrives, the
 * route fire-and-forget `request()`s the companion, and the tick drains here
 * asynchronously so chat never waits on it.
 *
 * Coalesced by companionId: a companion already queued or in flight is not
 * enqueued again — a tick is idempotent-ish (it re-reads live state and the gate
 * decides), so dropping a duplicate only defers a tick a little, and the periodic
 * sweep re-requests it. Drains serially; one bad tick never stalls the queue.
 */

import type { Logger } from '../logging.js';

/** What the runner drives — one companion's proactive tick (tests inject a fake). */
export interface MotivationTarget {
  tick(companionId: string): Promise<unknown>;
}

/** Backstop on distinct companions queued + in flight (overridable, e.g. tests). */
const DEFAULT_MAX_QUEUE_DEPTH = 1_000;

export class MotivationRunner {
  private readonly queue: string[] = [];
  /** companionIds queued OR in flight — the coalescing + cap set. */
  private readonly active = new Set<string>();
  private draining: Promise<void> | null = null;
  /** Once true, request() is a no-op so a draining queue can settle for shutdown. */
  private stopping = false;

  constructor(
    private readonly target: MotivationTarget,
    private readonly logger: Logger,
    private readonly maxQueueDepth: number = DEFAULT_MAX_QUEUE_DEPTH,
  ) {}

  /** Distinct companions queued plus the one draining. */
  pending(): number {
    return this.active.size;
  }

  /**
   * Request a proactive tick for a companion. No-op if one is already queued/in
   * flight (coalesced) or the backstop cap is reached (dropped with a log — the
   * sweep retries). Returns immediately; draining continues in the background.
   */
  request(companionId: string): void {
    if (this.stopping) {
      return;
    }
    if (this.active.has(companionId)) {
      return;
    }
    if (this.active.size >= this.maxQueueDepth) {
      this.logger.error('motivation queue full; dropping request (sweep will retry)', {
        operation: 'motivation.runner.request',
        companionId,
      });
      return;
    }
    this.active.add(companionId);
    this.queue.push(companionId);
    if (!this.draining) {
      this.draining = this.drain();
    }
  }

  /** Resolves when the queue has fully drained (tests, graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
  }

  /**
   * Stop accepting new requests, then resolve once the in-flight drain settles.
   * Idempotent. A dropped tail is recovered by the next sweep (ticks are
   * stateless — they re-read live state).
   */
  async close(): Promise<void> {
    this.stopping = true;
    await this.whenIdle();
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const companionId = this.queue.shift();
        if (!companionId) return;
        try {
          await this.target.tick(companionId);
        } catch (error) {
          // The engine logs + swallows its own failures; this guards the drain
          // loop against unexpected throws so one bad tick never stalls the queue.
          this.logger.error('motivation tick threw unexpectedly', {
            operation: 'motivation.runner.drain',
            companionId,
            error,
          });
        } finally {
          this.active.delete(companionId);
        }
      }
    } finally {
      this.draining = null;
    }
  }
}
