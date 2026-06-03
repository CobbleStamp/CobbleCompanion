/**
 * The chat surface: the companion's single continuous, streamed conversation.
 * Grounded turns render their citations ("Grounded in: …") under the
 * assistant's reply so the user always sees where an answer came from.
 */

import type { Citation, CompanionDto, MessageRole } from '@cobble/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchMessages, sendMessage } from '../api/client.js';

interface ChatProps {
  readonly companion: CompanionDto;
  readonly onSignOut: () => void;
  readonly onOpenMemory: () => void;
  readonly onOpenSources: () => void;
}

interface ChatLine {
  readonly role: MessageRole;
  readonly content: string;
  readonly citations?: readonly Citation[];
}

export function Chat({
  companion,
  onSignOut,
  onOpenMemory,
  onOpenSources,
}: ChatProps): JSX.Element {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        // A companion has one lifelong conversation, so resuming is just loading
        // its transcript — no session to pick or create.
        const history = await fetchMessages(companion.id);
        setLines(history.map((m) => ({ role: m.role, content: m.content })));
        setReady(true);
      } catch (err) {
        // Allow a retry on remount rather than getting stuck in a half-started state.
        startedRef.current = false;
        setError(err instanceof Error ? err.message : 'Failed to load conversation');
      }
    })();
  }, [companion.id]);

  async function onSend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || input.trim().length === 0 || busy) return;
    const content = input.trim();
    setInput('');
    setBusy(true);
    setLines((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }]);

    try {
      for await (const event_ of sendMessage(companion.id, content)) {
        if (event_.type === 'token') {
          setLines((prev) => appendToLast(prev, event_.value));
        } else if (event_.type === 'citations') {
          setLines((prev) => citeLast(prev, event_.citations));
        } else if (event_.type === 'error') {
          setLines((prev) => appendToLast(prev, `\n[${event_.message}]`));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="chat">
      <header>
        <h1>{companion.name}</h1>
        <nav className="header-actions">
          <button type="button" onClick={onOpenSources}>
            Sources
          </button>
          <button type="button" onClick={onOpenMemory}>
            Memory
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>
      {error && <p className="error">{error}</p>}
      <ul className="transcript">
        {lines.map((line, index) => (
          <li key={index} className={`line ${line.role}`}>
            <span className="who">{line.role === 'user' ? 'You' : companion.name}</span>
            <span className="content">{line.content}</span>
            {line.citations && line.citations.length > 0 && (
              <span className="citations who">
                Grounded in:{' '}
                {dedupeCitations(line.citations)
                  .map((citation) => formatCitation(citation))
                  .join(' · ')}
              </span>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={onSend}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Message ${companion.name}…`}
          disabled={!ready}
        />
        <button type="submit" disabled={busy || !ready}>
          Send
        </button>
      </form>
    </main>
  );
}

function appendToLast(lines: ChatLine[], delta: string): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), { ...last, content: last.content + delta }];
}

function citeLast(lines: ChatLine[], citations: readonly Citation[]): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), { ...last, citations }];
}

/** Collapse repeated passages from the same source span into one chip. */
function dedupeCitations(citations: readonly Citation[]): readonly Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.sourceId}:${citation.paraStart}-${citation.paraEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "Peru book (ch. 4, para 12–18)" — human-readable, locatable provenance. */
function formatCitation(citation: Citation): string {
  const parts = [
    citation.chapterTitle ? `ch. ${citation.chapterTitle}` : null,
    `para ${citation.paraStart}–${citation.paraEnd}`,
    citation.pageStart !== null ? `p. ${citation.pageStart}` : null,
  ].filter((part): part is string => part !== null);
  return `${citation.sourceTitle} (${parts.join(', ')})`;
}
