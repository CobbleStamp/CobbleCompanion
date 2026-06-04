/**
 * In-process consolidation runner — keeps episodic reflection OFF the request
 * path (mirrors the ingestion runner). A turn finishes, the route fire-and-forget
 * `request()`s the companion, and the reflection drains here asynchronously, so
 * chat never waits on it.
 *
 * Coalesced by companionId: a companion already queued or in flight is not
 * enqueued again — reflection is idempotent (cursor-driven) and the next turn or
 * the periodic sweep re-requests it, so dropping a duplicate only defers the tail
 * a little, never loses it. Drains serially; one bad run never stalls the queue.
 */

import type { Logger } from '../logging.js';

/** What the runner drives — one companion's reflection (tests inject a fake). */
export interface ConsolidationTarget {
  consolidate(companionId: string): Promise<void>;
}

/** Backstop on distinct companions queued + in flight (overridable, e.g. tests). */
const DEFAULT_MAX_QUEUE_DEPTH = 1_000;

export class ConsolidationRunner {
  private readonly queue: string[] = [];
  /** companionIds queued OR in flight — the coalescing + cap set. */
  private readonly active = new Set<string>();
  private draining: Promise<void> | null = null;
  /** Once true, request() is a no-op so a draining queue can settle for shutdown. */
  private stopping = false;

  constructor(
    private readonly target: ConsolidationTarget,
    private readonly logger: Logger,
    private readonly maxQueueDepth: number = DEFAULT_MAX_QUEUE_DEPTH,
  ) {}

  /** Distinct companions queued plus the one draining. */
  pending(): number {
    return this.active.size;
  }

  /**
   * Request a reflection for a companion. No-op if one is already queued/in
   * flight for it (coalesced) or if the backstop cap is reached (dropped with a
   * log — the sweep will pick it up later). Returns immediately; draining
   * continues in the background.
   */
  request(companionId: string): void {
    if (this.stopping) {
      // Shutting down: drop quietly. The startup sweep re-requests any pending
      // tail on the next boot (reflection is idempotent), so nothing is lost.
      return;
    }
    if (this.active.has(companionId)) {
      return;
    }
    if (this.active.size >= this.maxQueueDepth) {
      this.logger.error('consolidation queue full; dropping request (sweep will retry)', {
        operation: 'memory.consolidationRunner.request',
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
   * Idempotent. After this, request() is a no-op — so a concurrent request can't
   * start work that a graceful shutdown would fail to await. Any dropped tail is
   * recovered by the startup sweep on the next boot (reflection is idempotent).
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
          await this.target.consolidate(companionId);
        } catch (error) {
          // The service logs + swallows its own failures; this guards the drain
          // loop against unexpected throws so one bad run never stalls the queue.
          this.logger.error('consolidation run threw unexpectedly', {
            operation: 'memory.consolidationRunner.drain',
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
