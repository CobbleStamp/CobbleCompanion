/** BudgetMeter: renders both vitality pools, feeds a pool, fails quiet. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaminaEnergyDto } from '@cobble/shared';
import { fetchBudget, topUpBudget } from '../api/client.js';
import { BudgetMeter } from './BudgetMeter.js';

vi.mock('../api/client.js', () => ({
  fetchBudget: vi.fn(),
  topUpBudget: vi.fn(),
}));

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

function budget(staminaPct: number, energyPct: number): StaminaEnergyDto {
  return {
    stamina: {
      usedTokens: staminaPct,
      capTokens: 100,
      percentUsed: staminaPct,
      resetsAt: FAR_FUTURE,
    },
    energy: { usedTokens: energyPct, capTokens: 100, percentUsed: energyPct, resetsAt: FAR_FUTURE },
  };
}

describe('BudgetMeter', () => {
  beforeEach(() => {
    vi.mocked(fetchBudget).mockReset();
    vi.mocked(topUpBudget).mockReset();
  });

  it('renders both pool percentages once the budget loads', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(20, 70));
    render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(screen.getByText(/20%/)).toBeTruthy());
    expect(screen.getByText(/70%/)).toBeTruthy();
  });

  it('feeds the energy pool and shows the updated percentage', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(20, 90));
    vi.mocked(topUpBudget).mockResolvedValue(budget(20, 45));
    render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(screen.getByText(/90%/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Feed energy'));
    await waitFor(() => expect(screen.getByText(/45%/)).toBeTruthy());
    expect(topUpBudget).toHaveBeenCalledWith('c1', 'energy', expect.any(Number));
  });

  it('feeds the stamina pool and shows the updated percentage', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(80, 20));
    vi.mocked(topUpBudget).mockResolvedValue(budget(35, 20));
    render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(screen.getByText(/80%/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Feed stamina'));
    await waitFor(() => expect(screen.getByText(/35%/)).toBeTruthy());
    expect(topUpBudget).toHaveBeenCalledWith('c1', 'stamina', expect.any(Number));
  });

  it('does not update state after unmount while a feed is in flight (mountedRef guard)', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(20, 90));
    // Hold the feed open so the component unmounts before the top-up resolves.
    let resolveFeed: (b: StaminaEnergyDto) => void = () => {};
    vi.mocked(topUpBudget).mockReturnValue(
      new Promise<StaminaEnergyDto>((resolve) => {
        resolveFeed = resolve;
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(screen.getByText(/90%/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Feed energy'));
    expect(topUpBudget).toHaveBeenCalledTimes(1);
    // Unmount with the feed still pending, then let it resolve: the mountedRef
    // guard must skip the setBudget/setFeeding calls so React logs no
    // "state update on an unmounted component" warning.
    unmount();
    resolveFeed(budget(20, 45));
    await Promise.resolve();
    await waitFor(() => expect(topUpBudget).toHaveBeenCalledTimes(1));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('fires only one top-up when the feed button is double-tapped', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(20, 90));
    // Hold the top-up open so the second tap lands while the first is in flight.
    let resolveFeed: (b: StaminaEnergyDto) => void = () => {};
    vi.mocked(topUpBudget).mockReturnValue(
      new Promise<StaminaEnergyDto>((resolve) => {
        resolveFeed = resolve;
      }),
    );
    render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(screen.getByText(/90%/)).toBeTruthy());

    const feedButton = screen.getByLabelText('Feed energy');
    fireEvent.click(feedButton);
    fireEvent.click(feedButton); // re-entrant tap while the first is pending
    expect(feedButton).toHaveProperty('disabled', true);
    expect(topUpBudget).toHaveBeenCalledTimes(1);

    resolveFeed(budget(20, 45));
    await waitFor(() => expect(screen.getByText(/45%/)).toBeTruthy());
    expect(feedButton).toHaveProperty('disabled', false);
  });

  it('renders nothing when the poll fails', async () => {
    vi.mocked(fetchBudget).mockRejectedValue(new Error('down'));
    const { container } = render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(fetchBudget).toHaveBeenCalled());
    expect(container.querySelector('.budget-meter')).toBeNull();
  });
});
