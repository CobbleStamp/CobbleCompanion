/** The approval card: renders the action, wires Approve/Decline, surfaces errors. */

import type { ProposalDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProposalCard } from './ProposalCard.js';

const proposal: ProposalDto = {
  id: 'p1',
  toolName: 'ingest_source',
  summary: 'Read https://x.dev into long-term memory',
  status: 'pending',
  createdAt: '2026-06-04T00:00:00.000Z',
};

describe('ProposalCard', () => {
  it('shows what the companion wants to do', () => {
    render(<ProposalCard proposal={proposal} onConfirm={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText(/Read https:\/\/x\.dev into long-term memory/)).toBeTruthy();
  });

  it('approves with the proposal id', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard proposal={proposal} onConfirm={onConfirm} onReject={vi.fn()} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('p1'));
  });

  it('declines with the proposal id', async () => {
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard proposal={proposal} onConfirm={vi.fn()} onReject={onReject} />);
    fireEvent.click(screen.getByText('Decline'));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith('p1'));
  });

  it('surfaces an error if the action fails', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('over your daily limit'));
    render(<ProposalCard proposal={proposal} onConfirm={onConfirm} onReject={vi.fn()} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(screen.getByText(/over your daily limit/)).toBeTruthy());
  });
});
