/** UserModelPanel: lists the user-model facts and lets the user edit/forget them. */

import type { UserFactDto, UserFactsDto } from '@cobble/shared';
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
    salience: null,
    sensitive: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/** Build a user-model response from its Tier-1 facts and Tier-2 beliefs. */
function model(facts: readonly UserFactDto[], beliefs: readonly UserFactDto[] = []): UserFactsDto {
  return { facts, beliefs };
}

describe('UserModelPanel', () => {
  beforeEach(() => {
    vi.mocked(getUserFacts).mockReset();
    vi.mocked(updateUserFact).mockReset();
    vi.mocked(forgetUserFact).mockReset();
  });

  it('renders each fact with a friendly label and value', async () => {
    vi.mocked(getUserFacts).mockResolvedValue(
      model([fact('f1', 'name', 'Sam'), fact('f2', 'livesIn', 'Berlin')]),
    );
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeTruthy());
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Lives in')).toBeTruthy();
    expect(screen.getByText('Berlin')).toBeTruthy();
  });

  it('shows an empty state when nothing is known yet', async () => {
    vi.mocked(getUserFacts).mockResolvedValue(model([]));
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText(/learn about you as you chat/)).toBeTruthy());
  });

  it('edits a fact and reflects the authoritative new value', async () => {
    vi.mocked(getUserFacts).mockResolvedValue(model([fact('f1', 'name', 'Sam')]));
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
    vi.mocked(getUserFacts).mockResolvedValue(model([fact('f1', 'name', 'Sam')]));
    vi.mocked(forgetUserFact).mockResolvedValue();
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('Sam')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(screen.queryByText('Sam')).toBeNull());
    expect(forgetUserFact).toHaveBeenCalledWith('f1');
  });

  it('renders Tier-2 beliefs as editable/forgettable too (Phase 13)', async () => {
    vi.mocked(getUserFacts).mockResolvedValue(
      model([fact('f1', 'name', 'Sam')], [fact('b1', 'interestedIn', 'jazz')]),
    );
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('jazz')).toBeTruthy());
    expect(screen.getByText('Interested in')).toBeTruthy();
    // Both the Tier-1 fact and the Tier-2 belief now have edit/forget controls (one each → two).
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Forget' })).toHaveLength(2);
  });

  it('forgets a belief so it leaves the list', async () => {
    vi.mocked(getUserFacts).mockResolvedValue(
      model([fact('f1', 'name', 'Sam')], [fact('b1', 'interestedIn', 'jazz')]),
    );
    vi.mocked(forgetUserFact).mockResolvedValue();
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('jazz')).toBeTruthy());

    // The belief's Forget is the second one (after the Tier-1 fact's).
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[1]!);
    await waitFor(() => expect(screen.queryByText('jazz')).toBeNull());
    expect(forgetUserFact).toHaveBeenCalledWith('b1');
  });

  it('shows the Tier-3 user persona and a sensitive badge', async () => {
    vi.mocked(getUserFacts).mockResolvedValue(
      model([{ ...fact('f1', 'bornOn', '1990-05-01'), sensitive: true }]),
    );
    render(<UserModelPanel userPersona="They value candour and think out loud with you." />);
    await waitFor(() => expect(screen.getByText(/How Cobble understands you/)).toBeTruthy());
    expect(screen.getByText(/think out loud/)).toBeTruthy();
    expect(screen.getByText('sensitive')).toBeTruthy();
  });

  it('surfaces a load error', async () => {
    vi.mocked(getUserFacts).mockRejectedValue(new Error('network down'));
    render(<UserModelPanel />);
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
  });
});
