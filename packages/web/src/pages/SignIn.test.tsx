import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignIn } from './SignIn.js';

describe('SignIn', () => {
  it('calls onSignIn when the Google button is clicked', () => {
    const onSignIn = vi.fn();
    render(<SignIn onSignIn={onSignIn} />);

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
