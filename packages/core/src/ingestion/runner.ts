/**
 * In-process ingestion runner — keeps source reading off the request path
 * (architecture.md §8: the request enqueues and returns; parsing/LLM/embedding
 * happen asynchronously in this process). Jobs drain sequentially; the durable
 * status surface is the ingestion_jobs table, so replacing this with a real
 * out-of-process worker later needs no schema or API change.
 */

import type { Logger } from '../logging.js';
import type { IngestionRunParams } from './pipeline.js';

/** What the runner drives — the pipeline's run signature (tests inject a fake). */
export interface IngestionTarget {
  run(params: IngestionRunParams): Promise<void>;
}

/** Thrown by `enqueue` when the queue is at capacity; callers map it to 429. */
export class IngestionQueueFullError extends Error {
  constructor() {
    super('Cobble is busy reading other sources right now. Please try again shortly.');
    this.name = 'IngestionQueueFullError';
  }
}

/** Default backstop on queued + in-flight runs (overridable, e.g. tests). */
const DEFAULT_MAX_QUEUE_DEPTH = 100;

export class IngestionRunner {
  private readonly queue: IngestionRunParams[] = [];
  private draining: Promise<void> | null = null;
  private readonly maxQueueDepth: number;

  constructor(
    private readonly target: IngestionTarget,
    private readonly logger: Logger,
    maxQueueDepth: number = DEFAULT_MAX_QUEUE_DEPTH,
  ) {
    this.maxQueueDepth = maxQueueDepth;
  }

  /** Queued runs plus the one currently draining (in-flight). */
  pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  /** True when no further run can be accepted without exceeding the cap. */
  isFull(): boolean {
    return this.pending() >= this.maxQueueDepth;
  }

  /**
   * Queue a run and return immediately; draining continues in the background.
   * Throws `IngestionQueueFullError` when the backstop cap is reached so an
   * unbounded burst cannot grow memory without limit (the per-owner rate limit
   * is the first line of defense; this is the cross-owner ceiling).
   */
  enqueue(params: IngestionRunParams): void {
    if (this.isFull()) {
      throw new IngestionQueueFullError();
    }
    this.queue.push(params);
    if (!this.draining) {
      // drain() clears `draining` itself (in its finally) so `pending()` never
      // overcounts a finished drain. The push above guarantees drain hits an
      // await before finishing, so this assignment lands first.
      this.draining = this.drain();
    }
  }

  /** Resolves when all queued runs have finished (tests, graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const next = this.queue.shift();
        if (!next) return;
        try {
          await this.target.run(next);
        } catch (error) {
          // The pipeline marks its own job failed; this guards the drain loop
          // against unexpected throws so one bad run never stalls the queue.
          this.logger.error('ingestion run threw unexpectedly', {
            operation: 'ingestion.runner.drain',
            companionId: next.companionId,
            sourceId: next.sourceId,
            jobId: next.jobId,
            error,
          });
        }
      }
    } finally {
      // Cleared here — synchronously with the loop ending, before the returned
      // promise settles — so `pending()`/`isFull()` never count a drain that
      // has already finished its last run.
      this.draining = null;
    }
  }
}
