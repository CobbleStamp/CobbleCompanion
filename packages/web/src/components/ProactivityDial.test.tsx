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

  it('marks initial="off" as the active option', () => {
    render(<ProactivityDial companionId="c1" initial="off" />);
    expect(screen.getByRole('button', { name: 'off' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'gentle' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'active' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('marks initial="active" as the active option', () => {
    render(<ProactivityDial companionId="c1" initial="active" />);
    expect(screen.getByRole('button', { name: 'active' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'off' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'gentle' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('clicking the already-selected option is a no-op (does not save)', () => {
    render(<ProactivityDial companionId="c1" initial="gentle" />);
    fireEvent.click(screen.getByRole('button', { name: 'gentle' }));
    expect(setProactivityDial).not.toHaveBeenCalled();
  });

  it('clicking while a save is in flight is a no-op (saving guard)', async () => {
    // Hold the first save open so `saving` stays true, then click a different
    // option — the in-flight guard must drop it, leaving exactly one call.
    let resolveFirst: (dial: 'off' | 'gentle' | 'active') => void = () => {};
    vi.mocked(setProactivityDial).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    render(<ProactivityDial companionId="c1" initial="gentle" />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    // While the first save is pending, a second click on another option is ignored.
    fireEvent.click(screen.getByRole('button', { name: 'off' }));
    expect(setProactivityDial).toHaveBeenCalledTimes(1);
    expect(setProactivityDial).toHaveBeenCalledWith('c1', 'active');
    // Let the in-flight save settle so React state updates flush cleanly.
    resolveFirst('active');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'active' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
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
