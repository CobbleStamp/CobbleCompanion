/** UsageBadge: renders the polled stamina wallet balance, with tone + fail-quiet. */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUsage } from '../api/client.js';
import { UsageBadge } from './UsageBadge.js';

vi.mock('../api/client.js', () => ({ getUsage: vi.fn() }));

describe('UsageBadge', () => {
  beforeEach(() => {
    vi.mocked(getUsage).mockReset();
  });

  it('renders the remaining balance once usage loads', async () => {
    vi.mocked(getUsage).mockResolvedValue({ balanceTokens: 1_200_000 });
    render(<UsageBadge companionId="companion-1" />);
    await waitFor(() => expect(screen.getByText(/1\.2M left/)).toBeTruthy());
    expect(getUsage).toHaveBeenCalledWith('companion-1');
  });

  it('renders an empty, feed-me state when the wallet is drained', async () => {
    vi.mocked(getUsage).mockResolvedValue({ balanceTokens: 0 });
    const { container } = render(<UsageBadge companionId="companion-1" />);
    await waitFor(() => expect(screen.getByText(/empty — feed me/)).toBeTruthy());
    expect(container.querySelector('.usage-badge--full')).not.toBeNull();
  });

  it('renders nothing when the poll fails', async () => {
    vi.mocked(getUsage).mockRejectedValue(new Error('down'));
    const { container } = render(<UsageBadge companionId="companion-1" />);
    await waitFor(() => expect(getUsage).toHaveBeenCalled());
    expect(container.querySelector('.usage-badge')).toBeNull();
  });
});
