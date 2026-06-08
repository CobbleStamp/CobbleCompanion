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

  it('re-enables both buttons after a successful action (no permanently dead card)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard proposal={proposal} onConfirm={onConfirm} onReject={vi.fn()} />);
    const approve = screen.getByText('Approve') as HTMLButtonElement;
    const decline = screen.getByText('Decline') as HTMLButtonElement;

    fireEvent.click(approve);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('p1'));
    // The success path clears `busy`: the card may still be mounted (e.g. the
    // parent's refresh failed), and must not be stuck with dead buttons.
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(decline.disabled).toBe(false);
  });

  it('disables both buttons while a choice is in flight, guarding double-submit', async () => {
    let resolve: () => void = () => {};
    const onConfirm = vi.fn().mockReturnValue(new Promise<void>((r) => (resolve = r)));
    render(<ProposalCard proposal={proposal} onConfirm={onConfirm} onReject={vi.fn()} />);
    const approve = screen.getByText('Approve') as HTMLButtonElement;
    const decline = screen.getByText('Decline') as HTMLButtonElement;

    fireEvent.click(approve);
    await waitFor(() => expect(approve.disabled).toBe(true));
    expect(decline.disabled).toBe(true);
    // A second tap while in flight is inert — disabled buttons fire no handler.
    fireEvent.click(approve);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(approve.disabled).toBe(false));
  });

  it('surfaces an error if the action fails', async () => {
    // The card surfaces whatever message the rejected promise carries; the client
    // (confirmProposal → stream → send) now preserves the server's 409/429 body, so
    // this is the real out-of-stamina text the user sees end to end. The client side
    // of that contract is pinned in api/client.test.ts.
    const onConfirm = vi.fn().mockRejectedValue(new Error('Cobble is out of stamina for now.'));
    render(<ProposalCard proposal={proposal} onConfirm={onConfirm} onReject={vi.fn()} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(screen.getByText(/out of stamina/)).toBeTruthy());
  });
});
