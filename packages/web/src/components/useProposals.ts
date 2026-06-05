/**
 * Polls the companion's pending approval queue (propose→approve, P3) and exposes
 * the pending set, a reject action, and a manual refresh. Approving is driven by
 * the chat surface (it streams the companion's narration as the loop re-enters),
 * so confirm doesn't live here. Polls while any proposal is pending so one raised
 * mid-turn (or by background work later) shows up without a refresh; stops once
 * the queue is empty. Mirrors useIngestionJobs' poll-while-active loop.
 *
 * The poll re-arms off a tick that bumps after every refresh settles — including
 * failures — so a transient poll error doesn't permanently kill the loop while
 * proposals are still pending; it just retries on the next interval.
 */

import type { ProposalDto } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listProposals, rejectProposal } from '../api/client.js';

const POLL_INTERVAL_MS = 2_000;

export interface UseProposals {
  readonly proposals: readonly ProposalDto[];
  readonly error: string | null;
  /** Decline a proposal. */
  readonly reject: (proposalId: string) => Promise<void>;
  /** Force an immediate refresh (e.g. right after a turn ends in a proposal). */
  readonly refresh: () => Promise<void>;
}

export function useProposals(companionId: string): UseProposals {
  const [proposals, setProposals] = useState<readonly ProposalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bumps after every refresh settles (success or failure) to re-arm the poll.
  const [pollTick, setPollTick] = useState(0);
  const pollRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await listProposals(companionId);
      if (!mountedRef.current) return;
      setProposals(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('proposal poll failed', { companionId, error: err });
      setError(err instanceof Error ? err.message : 'Failed to load proposals');
    } finally {
      if (mountedRef.current) setPollTick((tick) => tick + 1);
    }
  }, [companionId]);

  const reject = useCallback(
    async (proposalId: string): Promise<void> => {
      await rejectProposal(companionId, proposalId);
      await refresh();
    },
    [companionId, refresh],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Poll while anything is pending; stop when the queue empties. Re-arming keys
  // off pollTick (bumped on every settle), so a failed poll still schedules the
  // next attempt instead of silently ending the loop.
  useEffect(() => {
    if (proposals.length === 0) return;
    pollRef.current = window.setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, [proposals, refresh, pollTick]);

  return { proposals, error, reject, refresh };
}
