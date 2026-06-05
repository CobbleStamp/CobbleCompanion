/**
 * Polls the companion's pending approval queue (propose→approve, P3) and exposes
 * the pending set, a reject action, and a manual refresh. Approving is driven by
 * the chat surface (it streams the companion's narration as the loop re-enters),
 * so confirm doesn't live here. It polls **fast while proposals are pending** and
 * **slowly while the queue is empty** — the slow poll is what surfaces a proposal
 * the Phase 4 motivation engine raises on its own, with nothing pending before it
 * (the queue-empties-stops loop of P3 would have missed it).
 *
 * The poll re-arms off a tick that bumps after every refresh settles — including
 * failures — so a transient poll error doesn't permanently kill the loop; it just
 * retries on the next interval.
 */

import type { ProposalDto } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listProposals, rejectProposal } from '../api/client.js';

/** Fast poll while the user is acting on a pending queue. */
const POLL_INTERVAL_MS = 2_000;
/** Slow poll while the queue is empty — catches an autonomously-raised proposal (P4). */
const IDLE_POLL_INTERVAL_MS = 12_000;

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

  // Always poll — fast while pending (the user is acting on the queue), slow while
  // empty (to surface a proposal the motivation engine raised on its own). Re-arms
  // off pollTick (bumped on every settle), so a failed poll still schedules the
  // next attempt instead of silently ending the loop.
  useEffect(() => {
    const interval = proposals.length > 0 ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    pollRef.current = window.setTimeout(() => void refresh(), interval);
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, [proposals, refresh, pollTick]);

  return { proposals, error, reject, refresh };
}
