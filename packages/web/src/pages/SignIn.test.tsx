import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignIn } from './SignIn.js';

// Mock GoogleLogin so the test never loads real Google Identity Services. The
// fake button invokes onSuccess with a credential, mirroring the ID-token flow.
vi.mock('@react-oauth/google', () => ({
  GoogleLogin: ({
    onSuccess,
  }: {
    onSuccess: (response: { credential?: string }) => void;
  }) => (
    <button type="button" onClick={() => onSuccess({ credential: 'fake-id-token' })}>
      Sign in with Google
    </button>
  ),
}));

describe('SignIn', () => {
  it('passes the Google credential to onCredential on success', () => {
    const onCredential = vi.fn();
    render(<SignIn onCredential={onCredential} />);

    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));

    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(onCredential).toHaveBeenCalledWith('fake-id-token');
  });
});
