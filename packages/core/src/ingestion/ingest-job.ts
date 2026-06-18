/**
 * The `ingest` job handler (deliver-scalability.md §5.1, §6 D-A). Ingestion runs
 * as durable, claim-serialised background work like consolidate/motivation, so a
 * companion's reads happen once, on any node. A fresh job reads the uploaded bytes
 * back from the staging store by their `uploadId` (the object key — object storage
 * or a filesystem root, never Postgres; staging-object-storage.md); a deferred job
 * (parked on an empty wallet) resumes from the parse held on its ingestion row. The
 * pipeline does the actual reading and marks its own durable status.
 */

import type { SourceKind } from '@cobble/shared';
import type { Logger } from '../logging.js';
import type { JobHandler } from '../jobs/job-processor.js';
import type { SemanticMemoryStore } from '../memory/semantic-store.js';
import type { IngestionPayload, IngestionTarget } from './pipeline.js';
import type { StagedUpload, StagedUploadConsumer } from './upload-staging.js';

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
const FAILED_INTERRUPTED = 'Reading was interrupted. Please re-upload this source.';

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
  readonly staging: StagedUploadConsumer;
  readonly logger: Logger;
}

/**
 * Build the `ingest` job handler. The job payload carries only references
 * (`sourceId`, `jobId`, and a fresh run's `uploadId`); the bytes live in the
 * staging store keyed by that `uploadId`. Never throws — the pipeline records its
 * own outcome, and a missing source/staged object is logged and turned into a
 * failed ingestion job.
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

    // A terminal row (done/failed) is already finished — this is a re-claim after
    // the outcome was recorded, so there is nothing to do.
    if (ctx.status === 'done' || ctx.status === 'failed') {
      return;
    }

    // Any other non-'queued' status (parsing/segmenting/enriching/embedding, or a
    // deferred row that lost its held parse) means a prior run died mid-pipeline.
    // The pipeline never throws — it always lands the row on a terminal status —
    // so a non-terminal row can only survive a hard process death. We are running
    // now because the original runner's per-companion claim lapsed and we re-claimed
    // it, which proves that runner is gone; this is the lease-driven recovery point.
    // Fail the job durably so the user re-uploads — we do not resume from a partial
    // run because earlier stages already wrote sections and re-running would
    // duplicate them. (Replaces the old global failInterruptedJobs boot sweep, which
    // could not distinguish a peer's live job from a stranded one — see
    // deliver-scalability.md D7.)
    if (ctx.status !== 'queued') {
      deps.logger.warn('ingest job interrupted mid-run; failing for re-upload', {
        operation: 'ingestion.job',
        jobId,
        status: ctx.status,
      });
      await deps.semantic.updateJob(jobId, {
        status: 'failed',
        error: FAILED_INTERRUPTED,
        parsedDoc: null,
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
