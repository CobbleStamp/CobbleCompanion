/**
 * A minimal reusable overlay dialog. Renders inline over its positioned parent
 * (like the chat's drag overlay) rather than through a portal — the app has no
 * portal root and a single overlay at a time is enough. Dismisses on backdrop
 * click, the close button, or Escape.
 */

import { useEffect } from 'react';

interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}

export function Modal({ open, title, onClose, children }: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Clicks inside the panel must not bubble up to the backdrop's close.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="link-button" aria-label="Close" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
