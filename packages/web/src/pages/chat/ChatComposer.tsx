/**
 * The message composer: the attach button + hidden file input, the auto-growing
 * multi-line textarea, and the send button. Owns only its own DOM refs and the
 * Gemini-style keyboard behaviour (Enter sends, Shift+Enter newlines, IME-safe); the
 * input value and the send/attach actions are the page's, passed in.
 */

import { UPLOAD_ACCEPT_ATTR } from '@cobble/shared';
import { useEffect, useRef } from 'react';

export interface ChatComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Submit the current input (Enter or the Send button). */
  readonly onSend: () => void;
  readonly onAttach: (file: File) => void;
  /** A turn/upload is in flight, or the surface isn't ready — block both intakes. */
  readonly disabled: boolean;
  readonly placeholder: string;
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onAttach,
  disabled,
  placeholder,
}: ChatComposerProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The multi-line composer, auto-grown to fit its content (see the effect below).
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Grow the composer with its content (Gemini-style), up to the CSS max-height,
  // then scroll. Runs on every input change — including the reset to '' after a
  // send, which snaps it back to a single row.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  /**
   * Enter sends; Shift+Enter inserts a newline (Gemini-style multi-line compose).
   * IME composition is respected so confirming a candidate with Enter never fires
   * an accidental send.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  }

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();
    onSend();
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="composer">
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT_ATTR}
          aria-label="Attach file source"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onAttach(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="attach-button"
          aria-label="Attach file"
          title="Attach a file"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <textarea
          ref={composerRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
        />
        <button type="submit" disabled={disabled}>
          Send
        </button>
      </div>
    </form>
  );
}
