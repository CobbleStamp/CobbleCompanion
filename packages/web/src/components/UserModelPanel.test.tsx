/** UserModelPanel: lists the user-model facts and lets the user edit/forget them. */

import type { UserFactDto } from '@cobble/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetUserFact, getUserFacts, updateUserFact } from '../api/client.js';
import { UserModelPanel } from './UserModelPanel.js';

vi.mock('../api/client.js', () => ({
  getUserFacts: vi.fn(),
  updateUserFact: vi.fn(),
  forgetUserFact: vi.fn(),
}));

function fact(id: string, predicate: string, object: string): UserFactDto {
  return {
    id,
    source: 'transcript',
    factType: 'attribute',
    subject: 'user',
    predicate,
    object,
    confidence: 0.9,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('UserModelPanel', () => {
  beforeEach(() => {
    vi.mocked(getUserFacts).mockReset();
    vi.mocked(updateUserFact).mockReset();
    vi.mocked(forgetUserFact).mockReset();
  });

  it('renders each fact with a friendly label and value', async () => {
    vi.mocked(getUserFacts).mockResolvedValue([
      fact('f1', 'name', 'Sam'),
      fact('f2', 'livesIn', 'Berlin'),
    ]);
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeTruthy());
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Lives in')).toBeTruthy();
    expect(screen.getByText('Berlin')).toBeTruthy();
  });

  it('shows an empty state when nothing is known yet', async () => {
    vi.mocked(getUserFacts).mockResolvedValue([]);
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText(/learn about you as you chat/)).toBeTruthy());
  });

  it('edits a fact and reflects the authoritative new value', async () => {
    vi.mocked(getUserFacts).mockResolvedValue([fact('f1', 'name', 'Sam')]);
    vi.mocked(updateUserFact).mockResolvedValue({
      ...fact('f1', 'name', 'Samuel'),
      source: 'user_edit',
    });
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit Name'), { target: { value: 'Samuel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Samuel')).toBeTruthy());
    expect(updateUserFact).toHaveBeenCalledWith('f1', 'Samuel');
  });

  it('forgets a fact so it leaves the list', async () => {
    vi.mocked(getUserFacts).mockResolvedValue([fact('f1', 'name', 'Sam')]);
    vi.mocked(forgetUserFact).mockResolvedValue();
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(screen.queryByText('Sam')).toBeNull());
    expect(forgetUserFact).toHaveBeenCalledWith('f1');
  });

  it('surfaces a load error', async () => {
    vi.mocked(getUserFacts).mockRejectedValue(new Error('network down'));
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
  });
});
