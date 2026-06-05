/** ProactivityDial: shows the current level, switches optimistically, reverts on failure. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProactivityDial } from '../api/client.js';
import { ProactivityDial } from './ProactivityDial.js';

vi.mock('../api/client.js', () => ({ setProactivityDial: vi.fn() }));

describe('ProactivityDial', () => {
  beforeEach(() => {
    vi.mocked(setProactivityDial).mockReset();
  });

  it('marks the initial level as active', () => {
    render(<ProactivityDial companionId="c1" initial="gentle" />);
    expect(screen.getByRole('button', { name: 'gentle' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('switches the dial and persists the choice', async () => {
    vi.mocked(setProactivityDial).mockResolvedValue('active');
    render(<ProactivityDial companionId="c1" initial="gentle" />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'active' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(setProactivityDial).toHaveBeenCalledWith('c1', 'active');
  });

  it('reverts to the previous level when the save fails', async () => {
    vi.mocked(setProactivityDial).mockRejectedValue(new Error('down'));
    render(<ProactivityDial companionId="c1" initial="gentle" />);
    fireEvent.click(screen.getByRole('button', { name: 'off' }));
    await waitFor(() => expect(setProactivityDial).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'gentle' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
  });
});
