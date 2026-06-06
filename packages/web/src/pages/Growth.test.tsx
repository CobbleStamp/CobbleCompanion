/** Growth view: renders the axes/abilities/personality and feeds via the kitchen. */

import type { GrowthDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { feedCompanion, fetchGrowth } from '../api/client.js';
import { Growth } from './Growth.js';

vi.mock('../api/client.js', () => ({
  fetchGrowth: vi.fn(),
  feedCompanion: vi.fn(),
  // The usage badge polls this; reject so it stays hidden.
  getUsage: vi.fn(() => Promise.reject(new Error('no usage'))),
}));

const baseGrowth: GrowthDto = {
  knowledge: { level: 2, progress: 0.5, detail: '4 sources · 3 episodes' },
  relationship: { level: 1, progress: 0.25, detail: '3 shared episodes' },
  abilities: [
    { key: 'web_research', label: 'Web research', unlocked: true },
    { key: 'memory_recall', label: 'Memory recall', unlocked: false },
  ],
  personality: {
    weights: {
      curiosity: 0.9,
      bond: 0.7,
      understanding: 0.5,
      approval: 0.5,
      helpfulness: 0.5,
      upkeep: 0.5,
    },
    spread: 0.3,
    evolvedPersona: 'a curious, warm companion',
  },
  overallStage: 2,
  emoji: '🦊',
  treats: 4,
};

describe('Growth view', () => {
  beforeEach(() => {
    vi.mocked(fetchGrowth).mockResolvedValue(baseGrowth);
    vi.mocked(feedCompanion).mockReset();
  });

  it('renders the stage, axes, abilities, and personality', async () => {
    render(<Growth companionName="Pebble" companionId="c1" onBack={() => {}} />);
    expect(await screen.findByText('Stage 2')).toBeTruthy();
    expect(screen.getByText('Knowledge')).toBeTruthy();
    expect(screen.getByText('Web research')).toBeTruthy();
    expect(screen.getByText('Who Pebble has become')).toBeTruthy();
    expect(screen.getByText(/curious, warm companion/)).toBeTruthy();
  });

  it('feeds the companion and updates the treats balance', async () => {
    vi.mocked(feedCompanion).mockResolvedValue({
      budget: {
        stamina: { usedTokens: 0, capTokens: 1, percentUsed: 0, resetsAt: '' },
        energy: { usedTokens: 0, capTokens: 1, percentUsed: 0, resetsAt: '' },
      },
      growth: { ...baseGrowth, treats: 3 },
    });
    render(<Growth companionName="Pebble" companionId="c1" onBack={() => {}} />);
    const sparkButton = await screen.findByRole('button', { name: /Spark/ });
    fireEvent.click(sparkButton);
    await waitFor(() => expect(feedCompanion).toHaveBeenCalledWith('c1', 'spark'));
    await waitFor(() => expect(screen.getByText(/3 treats/)).toBeTruthy());
  });
});
