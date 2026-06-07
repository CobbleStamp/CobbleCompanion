/** Growth view: renders the mirror axes/capabilities/character and feeds via the kitchen. */

import type { FoodInventoryDto, GrowthDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { feedCompanion, fetchGrowth, getFood } from '../api/client.js';
import { Growth } from './Growth.js';

vi.mock('../api/client.js', () => ({
  fetchGrowth: vi.fn(),
  feedCompanion: vi.fn(),
  getFood: vi.fn(),
  // The usage badge polls this; reject so it stays hidden.
  getUsage: vi.fn(() => Promise.reject(new Error('no usage'))),
}));

const baseGrowth: GrowthDto = {
  knowledge: { band: 'Broad', fill: 0.5, detail: '4 sources · 3 memories' },
  bond: { band: 'Familiar', fill: 0.25, detail: '3 shared episodes' },
  initiative: { band: 'Tentative', fill: 0.4, detail: '2 self-directed moves' },
  character: {
    band: 'Emerging',
    fill: 0.5,
    drives: [
      { key: 'curiosity', label: 'Curiosity', weight: 0.9 },
      { key: 'bond', label: 'Bond', weight: 0.7 },
    ],
    evolvedPersona: 'a curious, warm companion',
  },
  capabilities: [
    { key: 'web_research', label: 'Web research', observed: true },
    { key: 'memory_recall', label: 'Memory recall', observed: false },
  ],
};

const basePantry: FoodInventoryDto = { ration: 5, spark: 5, treat: 5 };

describe('Growth view', () => {
  beforeEach(() => {
    vi.mocked(fetchGrowth).mockResolvedValue(baseGrowth);
    vi.mocked(getFood).mockResolvedValue(basePantry);
    vi.mocked(feedCompanion).mockReset();
  });

  it('renders the mirror axes, capabilities, and character', async () => {
    render(<Growth companionName="Pebble" companionId="c1" onBack={() => {}} />);
    expect(await screen.findByText('Knowledge')).toBeTruthy();
    expect(screen.getByText('Initiative')).toBeTruthy();
    expect(screen.getByText('Broad')).toBeTruthy();
    expect(screen.getByText('Web research')).toBeTruthy();
    expect(screen.getByText('Who Pebble has become')).toBeTruthy();
    expect(screen.getByText(/curious, warm companion/)).toBeTruthy();
  });

  it('shows the pantry counts and feeds, updating the pantry from the result', async () => {
    vi.mocked(feedCompanion).mockResolvedValue({
      budget: {
        stamina: { balanceTokens: 1_000_000 },
        energy: { balanceTokens: 1_200_000 },
      },
      food: { ...basePantry, spark: 4 },
    });
    render(<Growth companionName="Pebble" companionId="c1" onBack={() => {}} />);
    const sparkButton = await screen.findByRole('button', { name: /Spark/ });
    // The pantry count is rendered on the button (×5 before feeding).
    expect(sparkButton.textContent).toContain('×5');

    fireEvent.click(sparkButton);
    await waitFor(() => expect(feedCompanion).toHaveBeenCalledWith('c1', 'spark'));
    // The pantry refreshes from result.food (×4 after).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Spark/ }).textContent).toContain('×4'),
    );
  });

  it('disables a food button when the pantry holds none of it', async () => {
    vi.mocked(getFood).mockResolvedValue({ ration: 0, spark: 5, treat: 5 });
    render(<Growth companionName="Pebble" companionId="c1" onBack={() => {}} />);
    const rationButton = await screen.findByRole('button', { name: /Ration/ });
    expect(rationButton).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Spark/ })).toHaveProperty('disabled', false);
  });
});
