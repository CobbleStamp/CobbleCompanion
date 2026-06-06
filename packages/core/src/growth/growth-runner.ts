/**
 * In-process growth runner (Phase 5) — keeps the post-turn growth recompute OFF
 * the request path (mirrors the consolidation/motivation runners). A turn
 * finishes, the route fire-and-forget `request()`s the companion, and the
 * recompute (which advances the mark, awards treats, and posts any growth note)
 * drains here, so chat never waits on it.
 *
 * Coalesced by companionId and idempotent (the snapshot mark makes re-runs safe),
 * so dropping a duplicate only defers a level-up note a little — the next turn or
 * a `GET /growth` recomputes it. Drains serially; one bad run never stalls the queue.
 */

import type { Logger } from '../logging.js';

/** What the runner drives — one companion's growth recompute (tests inject a fake). */
export interface GrowthRecomputeTarget {
  recompute(companionId: string): Promise<unknown>;
}

/** Backstop on distinct companions queued + in flight. */
const DEFAULT_MAX_QUEUE_DEPTH = 1_000;

export class GrowthRunner {
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private draining: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly target: GrowthRecomputeTarget,
    private readonly logger: Logger,
    private readonly maxQueueDepth: number = DEFAULT_MAX_QUEUE_DEPTH,
  ) {}

  /** Distinct companions queued plus the one draining. */
  pending(): number {
    return this.active.size;
  }

  /**
   * Request a growth recompute for a companion. No-op if one is already queued/in
   * flight (coalesced), if shutting down, or if the backstop cap is reached
   * (dropped with a log — a later turn/GET recomputes). Returns immediately.
   */
  request(companionId: string): void {
    if (this.stopping || this.active.has(companionId)) {
      return;
    }
    if (this.active.size >= this.maxQueueDepth) {
      this.logger.error('growth queue full; dropping request (a later turn/GET retries)', {
        operation: 'growth.runner.request',
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

  /** Stop accepting requests, then resolve once the in-flight drain settles. Idempotent. */
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
          await this.target.recompute(companionId);
        } catch (error) {
          this.logger.error('growth recompute threw unexpectedly', {
            operation: 'growth.runner.drain',
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
