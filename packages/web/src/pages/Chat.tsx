/**
 * The chat surface: the companion's single continuous, streamed conversation.
 * Grounded turns render their citations ("Grounded in: …") under the
 * assistant's reply so the user always sees where an answer came from.
 */

import type {
  Citation,
  CompanionDto,
  IngestionStatus,
  MessageDto,
  MessageRole,
} from '@cobble/shared';
import {
  UPLOAD_ACCEPT_ATTR,
  fileSourceAcknowledgement,
  uploadKindForFilename,
} from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMessages, sendMessage, uploadFileSource } from '../api/client.js';
import { IngestionPanel } from '../components/IngestionPanel.js';
import { IngestionStatusButton } from '../components/IngestionStatusButton.js';
import { Modal } from '../components/Modal.js';
import { ProposalCard } from '../components/ProposalCard.js';
import { UsageBadge } from '../components/UsageBadge.js';
import { useIngestionJobs } from '../components/useIngestionJobs.js';
import { useProposals } from '../components/useProposals.js';

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
   * as a 📎 chip. Both the chip and its acknowledgement are persisted as real
   * transcript turns (a `source_id`-linked message), so they survive a reload —
   * {@link messageToLine} rebuilds them from the transcript on mount.
   */
  readonly attachment?: boolean;
  /**
   * On an upload acknowledgement, the id of the source being ingested. Its
   * presence is what renders the "View status →" affordance on that line.
   */
  readonly sourceId?: string;
}

/**
 * Rebuild a transcript line from a persisted message. The 📎 chip and the
 * "View status →" link are derived purely from `role` + `sourceId`, so a turn
 * loaded on mount looks identical to the optimistic one shown right after upload.
 */
function messageToLine(m: MessageDto): ChatLine {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.sourceId !== null ? { sourceId: m.sourceId } : {}),
    attachment: m.role === 'user' && m.sourceId !== null,
  };
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
  const [statusOpen, setStatusOpen] = useState(false);
  const startedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Last seen status per ingestion job, to spot a job settling (→ done/failed)
  // across polls so we can pull in the companion's proactive note.
  const prevJobStatus = useRef<Map<string, IngestionStatus>>(new Map());
  // One poll for the whole chat surface, shared by the header badge and panel.
  const ingestion = useIngestionJobs(companion.id);
  // The pending approval queue (propose→approve, P3) — surfaced as cards below
  // the transcript; a turn that ends in a proposal triggers an immediate refresh.
  const proposalsCtl = useProposals(companion.id);

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
        setLines(history.map(messageToLine));
        setReady(true);
      } catch (err) {
        // Allow a retry on remount rather than getting stuck in a half-started state.
        startedRef.current = false;
        setError(err instanceof Error ? err.message : 'Failed to load conversation');
      }
    })();
  }, [companion.id]);

  /**
   * Pull any transcript turns we don't already have and append them. Merged by
   * id, so re-fetching never duplicates lines already shown (every persisted
   * line carries its server id). Used to deliver the companion's proactive
   * "finished reading…" note into an already-open chat.
   */
  const refreshTranscript = useCallback(async (): Promise<void> => {
    try {
      const history = await fetchMessages(companion.id);
      setLines((prev) => {
        const known = new Set(prev.map((line) => line.id).filter((id): id is string => !!id));
        const additions = history.filter((m) => !known.has(m.id)).map(messageToLine);
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    } catch (err) {
      console.error('transcript refresh failed', { companionId: companion.id, error: err });
    }
  }, [companion.id]);

  // When an ingestion job settles (→ done/failed), the companion posts a
  // proactive note server-side; fetch it in. Seeding the ref on the first run
  // (it starts empty) means a chat opened after completion doesn't re-announce —
  // that note is already in the mount-load transcript.
  useEffect(() => {
    const previous = prevJobStatus.current;
    const settled = ingestion.jobs.some((job) => {
      const before = previous.get(job.id);
      const wasUnsettled = before !== undefined && before !== 'done' && before !== 'failed';
      return wasUnsettled && (job.status === 'done' || job.status === 'failed');
    });
    prevJobStatus.current = new Map(ingestion.jobs.map((job) => [job.id, job.status]));
    if (settled) void refreshTranscript();
  }, [ingestion.jobs, refreshTranscript]);

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
        } else if (event_.type === 'proposal') {
          // The turn EXITed proposing an effectful action; pull it into the queue
          // (rendered as an approval card below the transcript).
          void proposalsCtl.refresh();
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
      const { source, messages } = await uploadFileSource(companion.id, file);
      // Swap the optimistic (id-less) chip for the persisted, reload-safe pair the
      // server wrote to the transcript. If the transcript write was skipped (the
      // upload still succeeds), fall back to optimistic lines so the UX is intact.
      const persisted: ChatLine[] =
        messages.length > 0
          ? messages.map(messageToLine)
          : [
              { role: 'user', content: file.name, attachment: true, sourceId: source.id },
              {
                role: 'assistant',
                content: fileSourceAcknowledgement(file.name),
                sourceId: source.id,
              },
            ];
      setLines((prev) => [...dropAttachmentTail(prev), ...persisted]);
    } catch (err) {
      // Drop the optimistic attachment chip and surface the failure.
      console.error('chat attach failed', { companionId: companion.id, error: err });
      setLines((prev) => dropAttachmentTail(prev));
      setError(err instanceof Error ? err.message : 'Failed to attach file');
    } finally {
      setAttaching(false);
    }
  }

  /** Approve a held action; the companion's confirmation lands in the transcript. */
  async function onConfirmProposal(proposalId: string): Promise<void> {
    const message = await proposalsCtl.confirm(proposalId);
    setLines((prev) => [...prev, messageToLine(message)]);
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
          <IngestionStatusButton
            activeCount={ingestion.active.length}
            onClick={() => setStatusOpen(true)}
          />
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
            {line.sourceId && !line.attachment && (
              <button type="button" className="link-button" onClick={() => setStatusOpen(true)}>
                View status →
              </button>
            )}
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
      {proposalsCtl.proposals.length > 0 && (
        <div className="proposal-queue">
          {proposalsCtl.proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onConfirm={onConfirmProposal}
              onReject={proposalsCtl.reject}
            />
          ))}
        </div>
      )}
      <Modal open={statusOpen} title="Reading status" onClose={() => setStatusOpen(false)}>
        <IngestionPanel jobs={ingestion.jobs} />
      </Modal>
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
