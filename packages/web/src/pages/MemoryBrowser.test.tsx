import type { CompanionDto, MemorySnapshotDto } from '@cobble/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    conversationCount: 1,
    messageCount: 2,
    conversations: [{ id: 'conv-1', createdAt: '2026-01-02T00:00:00.000Z', messageCount: 2 }],
  },
  semantic: { status: 'not_implemented', plannedPhase: 'Phase 1' },
  procedural: { status: 'not_implemented', plannedPhase: 'Phase 3' },
};

vi.mock('../api/client.js', () => ({
  getCompanionMemory: vi.fn(async () => snapshot),
  fetchMessages: vi.fn(async () => []),
}));

describe('MemoryBrowser', () => {
  it('renders identity, episodic counts, and planned sections', async () => {
    render(<MemoryBrowser companion={companion} onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Episodic — conversations/)).toBeTruthy());
    expect(screen.getByText('curious and warm')).toBeTruthy();
    expect(screen.getByText(/1 conversation · 2 messages/)).toBeTruthy();
    // Designed-but-unbuilt sections surface their planned phase.
    expect(screen.getByText(/planned for Phase 1/)).toBeTruthy();
    expect(screen.getByText(/planned for Phase 3/)).toBeTruthy();
  });
});
