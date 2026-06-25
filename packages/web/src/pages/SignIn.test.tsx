import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignIn } from './SignIn.js';

// Mock GoogleLogin so the test never loads real Google Identity Services. The
// fake button invokes onSuccess with a credential, mirroring the ID-token flow.
vi.mock('@react-oauth/google', () => ({
  GoogleLogin: ({ onSuccess }: { onSuccess: (response: { credential?: string }) => void }) => (
    <button type="button" onClick={() => onSuccess({ credential: 'fake-id-token' })}>
      Sign in with Google
    </button>
  ),
}));

describe('SignIn', () => {
  it('passes the Google credential to the session exchange on success', () => {
    const onCredential = vi.fn().mockResolvedValue(true);
    render(<SignIn onCredential={onCredential} />);

    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));

    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(onCredential).toHaveBeenCalledWith('fake-id-token');
  });

  it('shows an error when the session exchange is rejected', async () => {
    const onCredential = vi.fn().mockResolvedValue(false);
    render(<SignIn onCredential={onCredential} />);

    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));

    expect(await screen.findByText(/could not be completed/i)).toBeTruthy();
  });

  it('does not surface an error when the exchange succeeds', async () => {
    const onCredential = vi.fn().mockResolvedValue(true);
    render(<SignIn onCredential={onCredential} />);

    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));

    await waitFor(() => expect(onCredential).toHaveBeenCalled());
    expect(screen.queryByText(/could not be completed/i)).toBeNull();
  });
});
