/**
 * The `ingest` job handler (deliver-scalability.md §5.1, §6 D-A). Ingestion runs
 * as durable, claim-serialised background work like consolidate/motivation, so a
 * companion's reads happen once, on any node. A fresh job reads the uploaded bytes
 * from `upload_staging`; a deferred job (parked on an empty wallet) resumes from
 * the parse held on its ingestion row. The pipeline does the actual reading and
 * marks its own durable status.
 */

import type { SourceKind } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { JobHandler } from '../jobs/job-processor.js';
import type { SemanticMemoryStore } from '../memory/semantic-store.js';
import type { IngestionPayload, IngestionTarget } from './pipeline.js';
import type { StagedUpload, UploadStagingStore } from './upload-staging.js';

/** Raised when the ingest queue is at capacity; callers map it to 429 / a busy tool reply. */
export class IngestionQueueFullError extends Error {
  constructor() {
    super('Cobble is busy reading other sources right now. Please try again shortly.');
    this.name = 'IngestionQueueFullError';
  }
}

const FAILED_NO_BYTES =
  'Cobble could not read this source (its upload was lost). Please re-upload.';
const FAILED_EXPIRED =
  'Cobble could not read this source (its upload is no longer available). Please re-upload.';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode an intake payload for staging — note/link carry their text/URL as bytes. */
export function ingestionPayloadBytes(payload: IngestionPayload): {
  kind: SourceKind;
  bytes: Uint8Array;
} {
  switch (payload.kind) {
    case 'note':
      return { kind: 'note', bytes: encoder.encode(payload.text) };
    case 'link':
      return { kind: 'link', bytes: encoder.encode(payload.url) };
    default:
      return { kind: payload.kind, bytes: payload.bytes };
  }
}

/** Reconstruct the pipeline payload from a staged upload (inverse of the above). */
function payloadFromStaged(staged: StagedUpload): IngestionPayload {
  switch (staged.kind) {
    case 'note':
      return { kind: 'note', text: decoder.decode(staged.bytes) };
    case 'link':
      return { kind: 'link', url: decoder.decode(staged.bytes) };
    default:
      return { kind: staged.kind, bytes: staged.bytes };
  }
}

export interface IngestJobDeps {
  readonly pipeline: IngestionTarget;
  readonly semantic: Pick<SemanticMemoryStore, 'getRunContext' | 'updateJob'>;
  readonly staging: UploadStagingStore;
  readonly logger: Logger;
}

/**
 * Build the `ingest` job handler. The job payload carries only references
 * (`sourceId`, `jobId`, and a fresh run's `uploadId`); the bytes live in
 * `upload_staging`. Never throws — the pipeline records its own outcome, and a
 * missing source/staging row is logged and turned into a failed ingestion job.
 */
export function makeIngestJobHandler(deps: IngestJobDeps): JobHandler {
  return async (job): Promise<void> => {
    const { sourceId, jobId, uploadId } = job.payload;
    if (!sourceId || !jobId) {
      deps.logger.error('ingest job missing source/job reference', {
        operation: 'ingestion.job',
        jobId: job.id,
      });
      return;
    }
    const ctx = await deps.semantic.getRunContext(jobId);
    if (!ctx) {
      // The source/job was deleted before this job ran — nothing to do.
      return;
    }
    const base = {
      companionId: ctx.companionId,
      sourceId,
      jobId,
      sourceTitle: ctx.sourceTitle,
      ownerId: ctx.ownerId,
    };

    // Resume a deferred run from its held parse (the staged bytes are long gone).
    if (ctx.status === 'deferred' && ctx.parsedDoc) {
      await deps.pipeline.run({ ...base, resumeDocument: ctx.parsedDoc });
      return;
    }

    // Only a brand-new ('queued') job runs from staged bytes. A job already mid-
    // pipeline was interrupted by a crash — leave it for failInterruptedJobs on the
    // next restart rather than re-running and duplicating sections; a terminal job
    // (done/failed) is already finished.
    if (ctx.status !== 'queued') {
      deps.logger.warn('ingest job is not fresh; skipping', {
        operation: 'ingestion.job',
        jobId,
        status: ctx.status,
      });
      return;
    }

    if (!uploadId) {
      deps.logger.error('fresh ingest job has no staged upload', {
        operation: 'ingestion.job',
        jobId,
      });
      await deps.semantic.updateJob(jobId, { status: 'failed', error: FAILED_NO_BYTES });
      return;
    }
    const staged = await deps.staging.get(uploadId);
    if (!staged) {
      deps.logger.error('staged upload missing for ingest job', {
        operation: 'ingestion.job',
        jobId,
        uploadId,
      });
      await deps.semantic.updateJob(jobId, { status: 'failed', error: FAILED_EXPIRED });
      return;
    }
    try {
      await deps.pipeline.run({ ...base, payload: payloadFromStaged(staged) });
    } finally {
      // The bytes are consumed once the run returns: a done/failed run is finished,
      // and a deferred run kept its parse on the ingestion row, so they are never
      // needed again. Best-effort — a leaked row is swept by purgeExpired.
      await deps.staging.delete(uploadId).catch((error: unknown) =>
        deps.logger.error('failed to delete staged upload', {
          operation: 'ingestion.job',
          uploadId,
          error,
        }),
      );
    }
  };
}
