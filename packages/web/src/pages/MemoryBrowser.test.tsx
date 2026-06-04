import type { CompanionDto, MemorySnapshotDto, MessageDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMessages,
  getCompanionMemory,
  listEpisodes,
  searchEpisodes,
  searchMemory,
} from '../api/client.js';
import { MemoryBrowser } from './MemoryBrowser.js';

const companion: CompanionDto = {
  id: 'companion-1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and warm',
  evolvedPersona: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const snapshot: MemorySnapshotDto = {
  identity: companion,
  episodic: {
    status: 'available',
    messageCount: 2,
    episodeCount: 1,
  },
  semantic: { status: 'available', sourceCount: 3, sectionCount: 12, factCount: 7, jobs: [] },
  procedural: { status: 'not_implemented', plannedPhase: 'Phase 3' },
};

const transcript: MessageDto[] = [
  {
    id: 'm1',
    companionId: companion.id,
    sourceId: null,
    role: 'user',
    content: 'hello there',
    createdAt: '2026-01-03T00:00:01.000Z',
  },
  {
    id: 'm2',
    companionId: companion.id,
    sourceId: null,
    role: 'assistant',
    content: 'hi yourself',
    createdAt: '2026-01-03T00:00:02.000Z',
  },
];

vi.mock('../api/client.js', () => ({
  getCompanionMemory: vi.fn(),
  fetchMessages: vi.fn(),
  searchMemory: vi.fn(),
  listEpisodes: vi.fn(),
  searchEpisodes: vi.fn(),
  // The usage badge polls this; reject so it stays hidden in these tests.
  getUsage: vi.fn(() => Promise.reject(new Error('no usage'))),
}));

describe('MemoryBrowser', () => {
  beforeEach(() => {
    vi.mocked(getCompanionMemory).mockReset().mockResolvedValue(snapshot);
    vi.mocked(fetchMessages).mockReset().mockResolvedValue(transcript);
    vi.mocked(listEpisodes).mockReset().mockResolvedValue([]);
    vi.mocked(searchEpisodes).mockReset().mockResolvedValue([]);
  });

  it('renders identity, the episodic transcript, semantic counts, and planned sections', async () => {
    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Episodic — conversation/)).toBeTruthy());
    expect(screen.getByText(/curious and warm/)).toBeTruthy();
    expect(screen.getByText(/2 messages in one continuous conversation/)).toBeTruthy();
    // The semantic store surfaces what the companion has read.
    expect(screen.getByText(/3 sources · 12 sections · 7 facts/)).toBeTruthy();
    // Designed-but-unbuilt sections surface their planned phase.
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

  it('searches semantic memory and renders verbatim results with provenance', async () => {
    vi.mocked(searchMemory).mockResolvedValue([
      {
        citation: {
          sourceId: 's1',
          sourceTitle: 'Peru: A Culinary History',
          chapterTitle: null,
          topicTitle: 'Ceviche origins',
          paraStart: 12,
          paraEnd: 18,
          pageStart: null,
          pageEnd: null,
        },
        originalText: 'Ceviche is cured with lime juice along the coast.',
        score: 0.03,
      },
    ]);

    render(<MemoryBrowser companion={companion} onBack={() => {}} />);
    const input = await screen.findByLabelText('Search semantic memory');

    fireEvent.change(input, { target: { value: 'ceviche' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(screen.getByText('Ceviche is cured with lime juice along the coast.')).toBeTruthy(),
    );
    expect(
      screen.getByText(/Peru: A Culinary History · Ceviche origins · para 12–18/),
    ).toBeTruthy();
    expect(searchMemory).toHaveBeenCalledWith(companion.id, 'ceviche');
  });

  it('shows the evolved persona on the identity card once it exists', async () => {
    vi.mocked(getCompanionMemory).mockResolvedValue({
      ...snapshot,
      identity: {
        ...companion,
        evolvedPersona: "You've grown playful and know they cook to unwind.",
      },
    });

    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Who they've grown into/)).toBeTruthy());
    expect(screen.getByText(/cook to unwind/)).toBeTruthy();
    // The immutable seed is still shown alongside it.
    expect(screen.getByText(/Temperament at creation: curious and warm/)).toBeTruthy();
  });

  it('renders the episode timeline and recalls episodes by topic', async () => {
    vi.mocked(listEpisodes).mockResolvedValue([
      {
        id: 'ep1',
        summary: 'You loved the ceviche in Lima.',
        occurredStart: '2026-01-10T00:00:00.000Z',
        occurredEnd: '2026-01-10T01:00:00.000Z',
        salience: 0.9,
      },
    ]);
    vi.mocked(searchEpisodes).mockResolvedValue([
      {
        episode: {
          id: 'ep2',
          summary: 'You hiked Rainbow Mountain at altitude.',
          occurredStart: '2026-03-10T00:00:00.000Z',
          occurredEnd: '2026-03-10T01:00:00.000Z',
          salience: 0.7,
        },
        score: 0.04,
      },
    ]);

    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/1 consolidated memory/)).toBeTruthy());
    expect(screen.getByText('You loved the ceviche in Lima.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search episodic memory'), {
      target: { value: 'mountain' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    await waitFor(() =>
      expect(screen.getByText('You hiked Rainbow Mountain at altitude.')).toBeTruthy(),
    );
    expect(searchEpisodes).toHaveBeenCalledWith(companion.id, 'mountain');
  });

  it('hides the transcript control for a companion with no messages', async () => {
    vi.mocked(getCompanionMemory).mockResolvedValue({
      ...snapshot,
      episodic: { status: 'available', messageCount: 0, episodeCount: 0 },
    });

    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/0 messages in one continuous/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'View transcript' })).toBeNull();
  });
});
