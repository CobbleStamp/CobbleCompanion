/**
 * Discord settings panel tests (T13): the connect form when unconfigured, saving a
 * token (and clearing it from state after), and the /link code shown when configured
 * but not yet linked.
 */

import type { CompanionDto, DiscordConfigViewDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDiscordConfig,
  getDiscordConfig,
  listCompanions,
  regenerateDiscordLink,
  saveDiscordConfig,
} from '../api/client.js';
import { Discord } from './Discord.js';

const companion: CompanionDto = {
  id: 'companion-1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious',
  evolvedPersona: null,
  userPersona: null,
  proactivityDial: 'gentle',
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api/client.js', () => ({
  getDiscordConfig: vi.fn(),
  saveDiscordConfig: vi.fn(),
  regenerateDiscordLink: vi.fn(),
  deleteDiscordConfig: vi.fn(() => Promise.resolve()),
  listCompanions: vi.fn(() => Promise.resolve([companion])),
}));

const unconfigured: DiscordConfigViewDto = {
  configured: false,
  boundCompanionId: null,
  ownerLinked: false,
  linkCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function renderPanel(): void {
  render(<Discord companionName="Pebble" companionId="companion-1" onBack={() => {}} />);
}

describe('Discord settings panel', () => {
  it('shows the connect form when no bot is configured', async () => {
    vi.mocked(getDiscordConfig).mockResolvedValue(unconfigured);
    renderPanel();
    expect(await screen.findByText('Connect a Discord bot')).toBeTruthy();
    expect(screen.getByText(/No bot connected yet/)).toBeTruthy();
  });

  it('saves the token and clears it from the field afterwards', async () => {
    vi.mocked(getDiscordConfig).mockResolvedValue(unconfigured);
    vi.mocked(saveDiscordConfig).mockResolvedValue({
      configured: true,
      boundCompanionId: 'companion-1',
      ownerLinked: false,
      linkCode: 'ABCD2345',
    });
    renderPanel();

    const input = (await screen.findByLabelText('Bot token')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my-bot-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect bot' }));

    await waitFor(() =>
      expect(saveDiscordConfig).toHaveBeenCalledWith('my-bot-token', 'companion-1'),
    );
    // After save the /link code is shown and the secret is no longer in the field.
    expect(await screen.findByText(/ABCD2345/)).toBeTruthy();
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('');
  });

  it('regenerates the /link code', async () => {
    vi.mocked(getDiscordConfig).mockResolvedValue({
      configured: true,
      boundCompanionId: 'companion-1',
      ownerLinked: false,
      linkCode: 'OLDCODE1',
    });
    vi.mocked(regenerateDiscordLink).mockResolvedValue({
      configured: true,
      boundCompanionId: 'companion-1',
      ownerLinked: false,
      linkCode: 'NEWCODE9',
    });
    renderPanel();

    expect(await screen.findByText(/OLDCODE1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate code' }));
    await waitFor(() => expect(regenerateDiscordLink).toHaveBeenCalled());
    expect(await screen.findByText(/NEWCODE9/)).toBeTruthy();
  });

  it('disconnects the bot', async () => {
    vi.mocked(getDiscordConfig).mockResolvedValue({
      configured: true,
      boundCompanionId: 'companion-1',
      ownerLinked: true,
      linkCode: null,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect bot' }));
    await waitFor(() => expect(deleteDiscordConfig).toHaveBeenCalled());
    expect(await screen.findByText(/No bot connected yet/)).toBeTruthy();
  });
});
