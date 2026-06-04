/**
 * Polls the companion's ingestion jobs and joins each to its source title (the
 * job DTO carries only a sourceId). Instantiate once per surface and share its
 * result down — both the chat header indicator and the status panel read from a
 * single poll. Polling re-arms only while a job is still actively reading, so
 * settled (done/failed/deferred) jobs don't burn cycles. Mirrors the Sources
 * page's refresh loop.
 */

import type { IngestionJobDto } from '@cobble/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listIngestionJobs, listSources } from '../api/client.js';
import { isActiveJob } from '../lib/ingestionStatus.js';

const POLL_INTERVAL_MS = 1_500;

export interface JobWithTitle extends IngestionJobDto {
  /** The source's display title, joined client-side from listSources. */
  readonly title: string;
}

export interface UseIngestionJobs {
  /** Every job, newest-first as returned by the API, each with its title. */
  readonly jobs: readonly JobWithTitle[];
  /**
   * Jobs still actively reading (in flight). Drives the header "Reading…" badge,
   * so it deliberately excludes settled jobs — `failed`/`deferred` are not being
   * read and must not be counted as such (the panel still surfaces them).
   */
  readonly active: readonly JobWithTitle[];
  readonly error: string | null;
}

export function useIngestionJobs(companionId: string): UseIngestionJobs {
  const [jobs, setJobs] = useState<readonly JobWithTitle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  // Guards state updates from refreshes still in flight at unmount.
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextSources, nextJobs] = await Promise.all([
        listSources(companionId),
        listIngestionJobs(companionId),
      ]);
      if (!mountedRef.current) return;
      const titleBySource = new Map(nextSources.map((source) => [source.id, source.title]));
      setJobs(
        nextJobs.map((job) => ({ ...job, title: titleBySource.get(job.sourceId) ?? 'this file' })),
      );
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load ingestion status');
    }
  }, [companionId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Poll while any job is still reading; stop as soon as everything settles.
  useEffect(() => {
    if (!jobs.some(isActiveJob)) return;
    pollRef.current = window.setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, [jobs, refresh]);

  const active = useMemo(() => jobs.filter(isActiveJob), [jobs]);

  return { jobs, active, error };
}
