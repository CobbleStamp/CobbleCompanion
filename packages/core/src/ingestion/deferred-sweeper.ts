/**
 * Deferred-job sweeper (architecture.md §4.8). Ingestion jobs parked at the
 * daily token cap (`status: 'deferred'`) carry their parsed text; this resumes
 * the ones whose owner is now under cap, one at a time through the serial
 * runner. Run it on a timer and at startup. Because the runner's own quota gate
 * re-checks at run time, a queue drains *incrementally* across cycles: an owner
 * who crosses the cap again mid-drain simply leaves their remaining jobs parked.
 */

import type { Logger } from '../logging.js';
import type { SemanticMemoryStore } from '../memory/semantic-store.js';
import type { TokenQuotaStore } from '../quota/store.js';
import { IngestionQueueFullError, type IngestionRunner } from './runner.js';

export interface DeferredSweepDeps {
  readonly semantic: SemanticMemoryStore;
  readonly quota: TokenQuotaStore;
  readonly ingestion: IngestionRunner;
  readonly logger: Logger;
}

/**
 * Hand under-cap deferred jobs back to the runner. Each is claimed (flipped to
 * `queued`) before enqueue so a later sweep won't double-pick it; if the runner
 * is saturated the job is returned to the deferred pool and the sweep stops.
 * Best-effort and idempotent. Returns how many jobs were handed to the runner.
 */
export async function resumeDeferredJobs(deps: DeferredSweepDeps): Promise<number> {
  const jobs = await deps.semantic.listDeferredJobs();
  let resumed = 0;
  for (const job of jobs) {
    try {
      if (await deps.quota.isOverCap(job.ownerId)) {
        continue; // still over cap — leave it parked for a later sweep
      }
      // Claim before enqueue so the next sweep's `deferred` query skips it.
      await deps.semantic.updateJob(job.jobId, { status: 'queued' });
      try {
        deps.ingestion.enqueue({
          companionId: job.companionId,
          ownerId: job.ownerId,
          sourceId: job.sourceId,
          jobId: job.jobId,
          sourceTitle: job.sourceTitle,
          resumeDocument: job.parsedDoc,
        });
        resumed += 1;
      } catch (error) {
        if (error instanceof IngestionQueueFullError) {
          // Runner saturated — return it to the deferred pool and stop for now.
          await deps.semantic.updateJob(job.jobId, {
            status: 'deferred',
            parsedDoc: job.parsedDoc,
          });
          break;
        }
        throw error;
      }
    } catch (error) {
      deps.logger.error('failed to resume a deferred ingestion job', {
        operation: 'ingestion.resumeDeferredJobs',
        jobId: job.jobId,
        error,
      });
    }
  }
  return resumed;
}
