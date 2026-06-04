/** The approval-queue hook: loads pending proposals; reject refreshes it. */

import type { ProposalDto } from '@cobble/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
