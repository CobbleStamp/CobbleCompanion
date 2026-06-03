/** UsageBadge: renders the polled daily-usage percent, with tone + fail-quiet. */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUsage } from '../api/client.js';
import { UsageBadge } from './UsageBadge.js';

vi.mock('../api/client.js', () => ({ getUsage: vi.fn() }));

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

describe('UsageBadge', () => {
  beforeEach(() => {
    vi.mocked(getUsage).mockReset();
  });

  it('renders the percent used once usage loads', async () => {
    vi.mocked(getUsage).mockResolvedValue({
      usedTokens: 600,
      capTokens: 1000,
      percentUsed: 60,
      resetsAt: FAR_FUTURE,
    });
    render(<UsageBadge />);
    await waitFor(() => expect(screen.getByText(/60% used/)).toBeTruthy());
  });

  it('renders nothing when the poll fails', async () => {
    vi.mocked(getUsage).mockRejectedValue(new Error('down'));
    const { container } = render(<UsageBadge />);
    await waitFor(() => expect(getUsage).toHaveBeenCalled());
    expect(container.querySelector('.usage-badge')).toBeNull();
  });

  it('flags an over-cap state with the full tone', async () => {
    vi.mocked(getUsage).mockResolvedValue({
      usedTokens: 1000,
      capTokens: 1000,
      percentUsed: 100,
      resetsAt: FAR_FUTURE,
    });
    const { container } = render(<UsageBadge />);
    await waitFor(() => expect(container.querySelector('.usage-badge--full')).not.toBeNull());
  });
});
