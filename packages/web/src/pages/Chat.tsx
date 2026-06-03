/**
 * The chat surface: the companion's single continuous, streamed conversation.
 * Grounded turns render their citations ("Grounded in: …") under the
 * assistant's reply so the user always sees where an answer came from.
 */

import type { Citation, CompanionDto, MessageDto, MessageRole } from '@cobble/shared';
import { UPLOAD_ACCEPT_ATTR, uploadKindForFilename } from '@cobble/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchMessages, sendMessage, uploadFileSource } from '../api/client.js';
import { UsageBadge } from '../components/UsageBadge.js';

interface ChatProps {
  readonly companion: CompanionDto;
  readonly onSignOut: () => void;
  readonly onOpenMemory: () => void;
  readonly onOpenSources: () => void;
}

interface ChatLine {
  /**
   * The server message id once persisted (from the transcript or the `done`
   * event). Absent on optimistic lines that have not yet been confirmed, which
   * fall back to their array index for the React key.
   */
  readonly id?: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly citations?: readonly Citation[];
  /**
   * Marks a line as an attached file rather than a typed message, so it renders
   * as a 📎 chip. Attachment + acknowledgement lines are client-side only (the
   * upload goes through the sources endpoint, not the chat transcript), so they
   * don't survive a reload — the source itself persists and stays searchable.
   */
  readonly attachment?: boolean;
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
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // While a send is streaming or a file is uploading, the composer is locked so
  // the two intake paths never overlap.
  const locked = busy || attaching;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        // A companion has one lifelong conversation, so resuming is just loading
        // its transcript — no session to pick or create.
        const history = await fetchMessages(companion.id);
        setLines(history.map((m) => ({ id: m.id, role: m.role, content: m.content })));
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
    setError(null);
    setLines((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }]);

    try {
      for await (const event_ of sendMessage(companion.id, content)) {
        if (event_.type === 'token') {
          setLines((prev) => appendToLast(prev, event_.value));
        } else if (event_.type === 'citations') {
          setLines((prev) => citeLast(prev, event_.citations));
        } else if (event_.type === 'done') {
          // The authoritative persisted reply (server id + final content) replaces
          // whatever the token deltas built, and gives the line a stable key.
          setLines((prev) => finalizeLast(prev, event_.message));
        } else if (event_.type === 'error') {
          // A streamed failure is data: surface it inline on the assistant line.
          setLines((prev) => appendToLast(prev, `\n[${event_.message}]`));
        }
      }
    } catch (err) {
      // A thrown send (network failure, malformed SSE frame) leaves an empty
      // optimistic assistant bubble; drop it and surface the failure.
      console.error('chat send failed', { companionId: companion.id, error: err });
      setLines((prev) => dropEmptyAssistantTail(prev));
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hand a file to the companion: upload it to the knowledge base (background
   * ingestion via the sources endpoint), and reflect it in the transcript as a
   * 📎 chip followed by a canned acknowledgement. The file becomes searchable
   * once ingestion finishes; we don't block on it.
   */
  async function onAttach(file: File): Promise<void> {
    if (!ready || locked) return;
    // Validate before uploading — drag-and-drop bypasses the picker's `accept`
    // filter, so an unsupported file can still land here.
    if (uploadKindForFilename(file.name) === null) {
      setError('Unsupported file type — PDF, txt, md, docx, or pptx only');
      return;
    }
    setError(null);
    setAttaching(true);
    setLines((prev) => [...prev, { role: 'user', content: file.name, attachment: true }]);

    try {
      await uploadFileSource(companion.id, file);
      setLines((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Got it — I'm reading through "${file.name}" now. I'll be able to reference it once I've finished.`,
        },
      ]);
    } catch (err) {
      // Drop the optimistic attachment chip and surface the failure.
      console.error('chat attach failed', { companionId: companion.id, error: err });
      setLines((prev) => dropAttachmentTail(prev));
      setError(err instanceof Error ? err.message : 'Failed to attach file');
    } finally {
      setAttaching(false);
    }
  }

  function onDragOver(event: React.DragEvent): void {
    if (!ready || locked) return;
    event.preventDefault();
    setDragging(true);
  }

  function onDragLeave(event: React.DragEvent): void {
    event.preventDefault();
    setDragging(false);
  }

  function onDrop(event: React.DragEvent): void {
    event.preventDefault();
    setDragging(false);
    if (!ready || locked) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void onAttach(file);
  }

  return (
    <main
      className="chat"
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-overlay">Drop a file to add it</div>}
      <header>
        <h1>{companion.name}</h1>
        <nav className="header-actions">
          <UsageBadge />
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
          <li
            key={line.id ?? index}
            className={`line ${line.role}${line.attachment ? ' attachment' : ''}`}
          >
            <span className="who">{line.role === 'user' ? 'You' : companion.name}</span>
            <span className="content">{line.attachment ? `📎 ${line.content}` : line.content}</span>
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
        <div className="composer">
          <input
            ref={fileInputRef}
            type="file"
            accept={UPLOAD_ACCEPT_ATTR}
            aria-label="Attach file source"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onAttach(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="attach-button"
            aria-label="Attach file"
            title="Attach a file"
            disabled={locked || !ready}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${companion.name}…`}
            disabled={locked || !ready}
          />
          <button type="submit" disabled={locked || !ready}>
            Send
          </button>
        </div>
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

/**
 * Replace the streamed assistant line with the persisted message: the server's
 * content is authoritative over the concatenated token deltas, and its id
 * becomes the line's stable React key. Citations already attached during the
 * stream are preserved.
 */
function finalizeLast(lines: ChatLine[], message: MessageDto): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [
    ...lines.slice(0, -1),
    { ...last, id: message.id, role: message.role, content: message.content },
  ];
}

/**
 * Drop a trailing, still-empty optimistic assistant bubble — used when a send
 * throws before any token arrived, so the transcript isn't left with a blank
 * reply line.
 */
function dropEmptyAssistantTail(lines: ChatLine[]): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  if (last.role === 'assistant' && last.content.length === 0) {
    return lines.slice(0, -1);
  }
  return lines;
}

/**
 * Drop a trailing optimistic attachment chip — used when an upload throws, so the
 * transcript isn't left with a 📎 line for a file that never made it.
 */
function dropAttachmentTail(lines: ChatLine[]): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  if (last.attachment) return lines.slice(0, -1);
  return lines;
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
