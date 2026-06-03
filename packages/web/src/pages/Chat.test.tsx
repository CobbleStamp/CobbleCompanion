import type { CompanionDto, MessageDto } from '@cobble/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMessages } from '../api/client.js';
import { Chat } from './Chat.js';

const companion: CompanionDto = {
  id: 'companion-1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and warm',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const history: MessageDto[] = [
  {
    id: 'm1',
    companionId: companion.id,
    role: 'user',
    content: 'hello again',
    createdAt: '2026-01-03T00:00:01.000Z',
  },
  {
    id: 'm2',
    companionId: companion.id,
    role: 'assistant',
    content: 'welcome back',
    createdAt: '2026-01-03T00:00:02.000Z',
  },
];

vi.mock('../api/client.js', () => ({
  fetchMessages: vi.fn(),
  // sendMessage is imported by Chat but unused on mount; stub as an empty stream.
  sendMessage: vi.fn(async function* () {}),
}));

describe('Chat mount', () => {
  beforeEach(() => {
    vi.mocked(fetchMessages).mockReset();
  });

  it('resumes the companion transcript on open', async () => {
    vi.mocked(fetchMessages).mockResolvedValue(history);

    render(<Chat companion={companion} onSignOut={() => {}} onOpenMemory={() => {}} />);

    await waitFor(() => expect(screen.getByText('welcome back')).toBeTruthy());
    expect(screen.getByText('hello again')).toBeTruthy();
    // It loads the one continuous transcript, keyed by companion alone.
    expect(fetchMessages).toHaveBeenCalledWith(companion.id);
  });

  it('starts empty for a companion with no history', async () => {
    vi.mocked(fetchMessages).mockResolvedValue([]);

    render(<Chat companion={companion} onSignOut={() => {}} onOpenMemory={() => {}} />);

    await waitFor(() => expect(fetchMessages).toHaveBeenCalledWith(companion.id));
    expect(screen.queryByText('welcome back')).toBeNull();
  });

  it('surfaces an error and keeps the composer disabled when the transcript fails to load', async () => {
    vi.mocked(fetchMessages).mockRejectedValue(new Error('network down'));

    render(<Chat companion={companion} onSignOut={() => {}} onOpenMemory={() => {}} />);

    // The failure message is shown to the user rather than a half-started chat.
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    // The composer stays disabled because the transcript never became ready.
    expect((screen.getByPlaceholderText(/Message Pebble/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
