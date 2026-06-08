/** BudgetMeter: renders both vitality wallet balances; fails quiet. */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaminaEnergyDto } from '@cobble/shared';
import { fetchBudget } from '../api/client.js';
import { BudgetMeter } from './BudgetMeter.js';

vi.mock('../api/client.js', () => ({
  fetchBudget: vi.fn(),
}));

function budget(staminaTokens: number, energyTokens: number): StaminaEnergyDto {
  return {
    stamina: { balanceTokens: staminaTokens },
    energy: { balanceTokens: energyTokens },
  };
}

describe('BudgetMeter', () => {
  beforeEach(() => {
    vi.mocked(fetchBudget).mockReset();
  });

  it('renders both wallet balances once the budget loads', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(1_200_000, 8_000));
    render(<BudgetMeter companionId="c1" />);
    // Compact format: 1.2M stamina, 8k energy.
    await waitFor(() => expect(screen.getByText(/1\.2M/)).toBeTruthy());
    expect(screen.getByText(/8k/)).toBeTruthy();
  });

  it('shows no manual top-up affordance (refilling is the Kitchen)', async () => {
    vi.mocked(fetchBudget).mockResolvedValue(budget(900_000, 800_000));
    render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(screen.getByText(/900k/)).toBeTruthy());
    expect(screen.queryByLabelText('Feed energy')).toBeNull();
    expect(screen.queryByLabelText('Feed stamina')).toBeNull();
  });

  it('renders nothing when the poll fails', async () => {
    vi.mocked(fetchBudget).mockRejectedValue(new Error('down'));
    const { container } = render(<BudgetMeter companionId="c1" />);
    await waitFor(() => expect(fetchBudget).toHaveBeenCalled());
    expect(container.querySelector('.budget-meter')).toBeNull();
  });
});
