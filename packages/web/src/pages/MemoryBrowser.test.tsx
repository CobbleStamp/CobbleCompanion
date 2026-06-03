import type { CompanionDto, MemorySnapshotDto, MessageDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMessages, getCompanionMemory } from '../api/client.js';
import { MemoryBrowser } from './MemoryBrowser.js';

const companion: CompanionDto = {
  id: 'companion-1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and warm',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const snapshot: MemorySnapshotDto = {
  identity: companion,
  episodic: {
    status: 'available',
    messageCount: 2,
  },
  semantic: { status: 'not_implemented', plannedPhase: 'Phase 1' },
  procedural: { status: 'not_implemented', plannedPhase: 'Phase 3' },
};

const transcript: MessageDto[] = [
  {
    id: 'm1',
    companionId: companion.id,
    role: 'user',
    content: 'hello there',
    createdAt: '2026-01-03T00:00:01.000Z',
  },
  {
    id: 'm2',
    companionId: companion.id,
    role: 'assistant',
    content: 'hi yourself',
    createdAt: '2026-01-03T00:00:02.000Z',
  },
];

vi.mock('../api/client.js', () => ({
  getCompanionMemory: vi.fn(),
  fetchMessages: vi.fn(),
}));

describe('MemoryBrowser', () => {
  beforeEach(() => {
    vi.mocked(getCompanionMemory).mockReset().mockResolvedValue(snapshot);
    vi.mocked(fetchMessages).mockReset().mockResolvedValue(transcript);
  });

  it('renders identity, the single episodic transcript, and planned sections', async () => {
    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Episodic — conversation/)).toBeTruthy());
    expect(screen.getByText('curious and warm')).toBeTruthy();
    expect(screen.getByText(/2 messages in one continuous conversation/)).toBeTruthy();
    // Designed-but-unbuilt sections surface their planned phase.
    expect(screen.getByText(/planned for Phase 1/)).toBeTruthy();
    expect(screen.getByText(/planned for Phase 3/)).toBeTruthy();
  });

  it('toggles the one continuous transcript, loading it keyed by companion alone', async () => {
    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    const view = await screen.findByRole('button', { name: 'View transcript' });
    fireEvent.click(view);

    await waitFor(() => expect(screen.getByText('hello there')).toBeTruthy());
    expect(screen.getByText('hi yourself')).toBeTruthy();
    expect(fetchMessages).toHaveBeenCalledWith(companion.id);

    // Toggling closed hides the transcript again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
    await waitFor(() => expect(screen.queryByText('hello there')).toBeNull());
  });

  it('hides the transcript control for a companion with no messages', async () => {
    vi.mocked(getCompanionMemory).mockResolvedValue({
      ...snapshot,
      episodic: { status: 'available', messageCount: 0 },
    });

    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/0 messages in one continuous/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'View transcript' })).toBeNull();
  });
});
