/** The approval-queue hook: loads pending proposals; reject refreshes it. */

import type { ProposalDto } from '@cobble/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listProposals, rejectProposal } from '../api/client.js';
import { useProposals } from './useProposals.js';

vi.mock('../api/client.js', () => ({
  listProposals: vi.fn(),
  rejectProposal: vi.fn(),
}));

const pending: ProposalDto = {
  id: 'p1',
  toolName: 'ingest_source',
  summary: 'Read https://x.dev into memory',
  status: 'pending',
  createdAt: '2026-06-04T00:00:00.000Z',
};

describe('useProposals', () => {
  beforeEach(() => {
    vi.mocked(listProposals).mockReset().mockResolvedValue([pending]);
    vi.mocked(rejectProposal).mockReset().mockResolvedValue(undefined);
  });

  it('loads the pending queue on mount', async () => {
    const { result } = renderHook(() => useProposals('c1'));
    await waitFor(() => expect(result.current.proposals).toEqual([pending]));
    expect(listProposals).toHaveBeenCalledWith('c1');
  });

  it('reject declines and refreshes', async () => {
    const { result } = renderHook(() => useProposals('c1'));
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));
    vi.mocked(listProposals).mockResolvedValue([]);
    await act(async () => {
      await result.current.reject('p1');
    });
    expect(rejectProposal).toHaveBeenCalledWith('c1', 'p1');
    await waitFor(() => expect(result.current.proposals).toEqual([]));
  });
});

describe('useProposals polling', () => {
  const POLL_MS = 2_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listProposals).mockReset().mockResolvedValue([pending]);
    vi.mocked(rejectProposal).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Flush the mount refresh's pending promise without advancing the clock.
  const flush = (): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const tick = (): Promise<void> =>
    act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));

  it('re-arms the poll while a proposal stays pending', async () => {
    const { result } = renderHook(() => useProposals('c1'));
    await flush();
    expect(result.current.proposals).toHaveLength(1);
    expect(listProposals).toHaveBeenCalledTimes(1);

    await tick();
    expect(listProposals).toHaveBeenCalledTimes(2);

    // A third tick proves it keeps re-arming, not a single one-shot poll.
    await tick();
    expect(listProposals).toHaveBeenCalledTimes(3);
  });

  it('stops polling once the queue empties', async () => {
    const { result } = renderHook(() => useProposals('c1'));
    await flush();
    expect(result.current.proposals).toHaveLength(1);

    vi.mocked(listProposals).mockResolvedValue([]);
    await tick();
    expect(result.current.proposals).toEqual([]);
    const callsAfterEmpty = vi.mocked(listProposals).mock.calls.length;

    // Further time passes with no new poll — the loop has stopped.
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 3)));
    expect(listProposals).toHaveBeenCalledTimes(callsAfterEmpty);
  });

  it('clears the pending poll timer on unmount', async () => {
    const { unmount } = renderHook(() => useProposals('c1'));
    await flush();
    const callsBeforeUnmount = vi.mocked(listProposals).mock.calls.length;

    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 3)));
    expect(listProposals).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it('keeps polling — and recovers — after a failed poll', async () => {
    const onError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useProposals('c1'));
    await flush();
    expect(result.current.proposals).toHaveLength(1);

    // A transient failure: the error surfaces and is logged, but the queue is
    // still pending so the loop must keep going.
    vi.mocked(listProposals).mockRejectedValueOnce(new Error('network blip'));
    await tick();
    expect(result.current.error).toBe('network blip');
    expect(result.current.proposals).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      'proposal poll failed',
      expect.objectContaining({ companionId: 'c1' }),
    );

    // The next interval polls again and clears the error — the loop survived.
    await tick();
    expect(result.current.error).toBeNull();
    expect(listProposals).toHaveBeenCalledTimes(3);

    onError.mockRestore();
  });
});
