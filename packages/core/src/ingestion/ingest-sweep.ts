/**
 * Deferred-ingestion catch-up (architecture.md §4.8; deliver-scalability.md §6
 * D-A) — the job-queue successor to the old in-process deferred sweeper. Ingestion
 * jobs parked on an empty stamina wallet (`status: 'deferred'`) keep their parsed
 * text on the ingestion row; this requests an `ingest` job for the ones whose
 * companion has since been fed. Run on a timer + at startup. The `ingest:{sourceId}`
 * coalescing key + the per-companion claim make double-requesting safe, and the
 * pipeline re-checks the wallet at run time — so no separate claim/flip is needed.
 */

import type { Logger } from '../logging.js';
import type { IngestWorkRequester } from '../jobs/job-processor.js';
import type { SemanticMemoryStore } from '../memory/semantic-store.js';
import type { VitalityStore } from '../quota/vitality-store.js';

export interface IngestionSweepDeps {
  readonly semantic: Pick<SemanticMemoryStore, 'listDeferredJobs'>;
  readonly quota: VitalityStore;
  readonly ingest: IngestWorkRequester;
  readonly logger: Logger;
}

/** Request a resume for each under-cap deferred job. Returns how many were requested. */
export async function sweepIngestion(deps: IngestionSweepDeps): Promise<number> {
  const jobs = await deps.semantic.listDeferredJobs();
  let requested = 0;
  for (const job of jobs) {
    try {
      if (await deps.quota.isEmpty(job.companionId)) {
        continue; // still empty — leave it parked for a later sweep
      }
      deps.ingest.request({
        companionId: job.companionId,
        sourceId: job.sourceId,
        jobId: job.jobId,
      });
      requested += 1;
    } catch (error) {
      deps.logger.error('failed to request a deferred ingestion resume', {
        operation: 'ingestion.sweepIngestion',
        jobId: job.jobId,
        error,
      });
    }
  }
  return requested;
}
