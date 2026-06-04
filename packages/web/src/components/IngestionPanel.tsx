/**
 * The body of the in-chat "Reading status" overlay: every source the companion
 * is still working through — in progress, failed, or deferred. Finished (`done`)
 * jobs are intentionally hidden; this is a "what's happening now" view. Status
 * text comes from the shared label helper so it matches the Sources page exactly.
 */

import { isPendingJob, jobStatusLabel } from '../lib/ingestionStatus.js';
import type { JobWithTitle } from './useIngestionJobs.js';

interface IngestionPanelProps {
  readonly jobs: readonly JobWithTitle[];
}

export function IngestionPanel({ jobs }: IngestionPanelProps): JSX.Element {
  const pending = jobs.filter(isPendingJob);

  if (pending.length === 0) {
    return <p className="who">Nothing in progress right now.</p>;
  }

  return (
    <ul className="memory-list">
      {pending.map((job) => (
        <li key={job.id} className="memory-section">
          <strong>{job.title}</strong>
          <p className="who">{jobStatusLabel(job)}</p>
        </li>
      ))}
    </ul>
  );
}
