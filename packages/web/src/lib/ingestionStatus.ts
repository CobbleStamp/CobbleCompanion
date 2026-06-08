/**
 * Shared rendering logic for an ingestion job's progress. Kept here (not inline
 * in a page) so the Sources page and the in-chat status panel show identical
 * labels — the two must never drift.
 */

import type { IngestionJobDto } from '@cobble/shared';

/**
 * Job states that still change on their own — callers poll while any source is
 * in one. `deferred` is excluded: it waits (possibly hours) for the companion to
 * be fed (its stamina wallet refilled), so fast polling would be wasteful.
 * `failed`/`done` are terminal.
 */
export function isActiveJob(job: IngestionJobDto): boolean {
  return job.status !== 'done' && job.status !== 'failed' && job.status !== 'deferred';
}

/**
 * A job worth showing in the "what's still happening" view: anything not yet
 * `done` — in progress, failed, or deferred. Drives the chat status panel's
 * filter and the header indicator's visibility.
 */
export function isPendingJob(job: IngestionJobDto): boolean {
  return job.status !== 'done';
}

/** The one human-readable status line for a job, shared across surfaces. */
export function jobStatusLabel(job: IngestionJobDto): string {
  if (job.status === 'done') return `read · ${job.sectionsTotal} sections`;
  if (job.status === 'failed') return `failed: ${job.error ?? 'unknown error'}`;
  if (job.status === 'deferred') {
    return 'waiting to be fed, then Cobble finishes reading it';
  }
  return `${job.status}… ${job.sectionsDone}/${job.sectionsTotal || '?'} sections`;
}
