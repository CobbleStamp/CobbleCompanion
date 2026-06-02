import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client.js', () => ({
  requestMagicLink: vi.fn().mockResolvedValue(undefined),
}));

import { requestMagicLink } from '../api/client.js';
import { SignIn } from './SignIn.js';

describe('SignIn', () => {
  it('requests a magic link and shows confirmation', async () => {
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeDefined();
    });
    expect(requestMagicLink).toHaveBeenCalledWith('ada@example.com');
  });
});
