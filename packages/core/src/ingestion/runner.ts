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

export class IngestionRunner {
  private readonly queue: IngestionRunParams[] = [];
  private draining: Promise<void> | null = null;

  constructor(
    private readonly target: IngestionTarget,
    private readonly logger: Logger,
  ) {}

  /** Queue a run and return immediately; draining continues in the background. */
  enqueue(params: IngestionRunParams): void {
    this.queue.push(params);
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  /** Resolves when all queued runs have finished (tests, graceful shutdown). */
  async whenIdle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
  }

  private async drain(): Promise<void> {
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
  }
}
