/**
 * Modal tests: open/closed rendering and the three dismissal paths (backdrop,
 * close button, Escape).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal.js';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} title="Reading status" onClose={() => {}}>
        <p>inside</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('inside')).toBeNull();
  });

  it('renders the titled dialog and its children when open', () => {
    render(
      <Modal open title="Reading status" onClose={() => {}}>
        <p>inside</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Reading status');
    expect(screen.getByText('inside')).toBeTruthy();
  });

  it('closes on the close button, the backdrop, and Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Reading status" onClose={onClose}>
        <p>inside</p>
      </Modal>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The backdrop is the dialog's parent; clicking it dismisses.
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not close when a click lands inside the panel', () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Reading status" onClose={onClose}>
        <p>inside</p>
      </Modal>,
    );

    fireEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
