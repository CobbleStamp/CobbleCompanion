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
    stamina: { usedTokens: staminaPct, capTokens: 100, percentUsed: staminaPct, resetsAt: FAR_FUTURE },
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

  it('renders nothing when the poll fails', async () => {
    vi.mocked(fetchBudget).mockRejectedValue(new Error('down'));
    const { container } = render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(fetchBudget).toHaveBeenCalled());
    expect(container.querySelector('.budget-meter')).toBeNull();
  });
});
