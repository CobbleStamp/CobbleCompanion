/** Growth view: renders the mirror axes/capabilities/character and feeds via the kitchen. */

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
  knowledge: { band: 'Broad', fill: 0.5, detail: '4 sources · 3 memories' },
  bond: { band: 'Familiar', fill: 0.25, detail: '3 shared episodes' },
  initiative: { band: 'Tentative', fill: 0.4, detail: '2 self-directed moves' },
  character: {
    band: 'Emerging',
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
  treats: 4,
};

describe('Growth view', () => {
  beforeEach(() => {
    vi.mocked(fetchGrowth).mockResolvedValue(baseGrowth);
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
