/**
 * The chat surface: the companion's single continuous, streamed conversation.
 * Grounded turns render their citations ("Grounded in: …") under the
 * assistant's reply so the user always sees where an answer came from.
 */

import type {
  ChatStreamEvent,
  Citation,
  CompanionDto,
  IngestionStatus,
  MessageDto,
  MessageKind,
  MessageRole,
} from '@cobble/shared';
import {
  UPLOAD_ACCEPT_ATTR,
  fileSourceAcknowledgement,
  uploadKindForFilename,
} from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  confirmProposal,
  fetchMessages,
  sendMessage,
  streamGreeting,
  subscribeMessages,
  uploadFileSource,
} from '../api/client.js';
import { IngestionPanel } from '../components/IngestionPanel.js';
import { IngestionStatusButton } from '../components/IngestionStatusButton.js';
import { MarkdownMessage } from '../components/MarkdownMessage.js';
import { Modal } from '../components/Modal.js';
import { ProposalCard } from '../components/ProposalCard.js';
import { BudgetMeter } from '../components/BudgetMeter.js';
import { ProactivityDial } from '../components/ProactivityDial.js';
import { useIngestionJobs } from '../components/useIngestionJobs.js';
import { usePresenceHeartbeat } from '../components/usePresenceHeartbeat.js';
import { useProposals } from '../components/useProposals.js';

interface ChatProps {
  readonly companion: CompanionDto;
  readonly onSignOut: () => void;
  readonly onOpenMemory: () => void;
  readonly onOpenSources: () => void;
  readonly onOpenGrowth: () => void;
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
  /**
   * What this line is. `tool_step` renders as a muted "looked something up" note;
   * `proposal` renders as a held-action log entry. Absent/`message` is an
   * ordinary turn. Mirrors the transcript row's kind so reload == live.
   */
  readonly kind?: MessageKind;
  /** On a `proposal` line, the proposal it records (links it to the live queue). */
  readonly proposalId?: string;
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
  const kind = m.kind ?? 'message';
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    kind,
    ...(m.metadata?.citations ? { citations: m.metadata.citations } : {}),
    ...(m.metadata?.proposalId ? { proposalId: m.metadata.proposalId } : {}),
    ...(m.sourceId !== null ? { sourceId: m.sourceId } : {}),
    attachment: m.role === 'user' && m.sourceId !== null,
  };
}

/** Reconnect backoff bounds for the standing event channel (implementation.md §3). */
const CHANNEL_INITIAL_BACKOFF_MS = 1000;
const CHANNEL_MAX_BACKOFF_MS = 15000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Merge one pushed/persisted row into the rendered lines, keyed by server id
 * (architecture.md §6). Already present by id → no-op: the per-turn stream, the
 * snapshot, and the channel can each deliver the same row. Otherwise reconcile the
 * optimistic, id-less echo of a row this client just sent — a user line matched by
 * content — by adopting the authoritative row in place; a genuinely new row is
 * appended (the channel and snapshot both deliver in chronological order).
 */
function mergeMessage(lines: ChatLine[], message: MessageDto): ChatLine[] {
  if (lines.some((line) => line.id === message.id)) return lines;
  if (message.role === 'user') {
    const optimistic = lines.findIndex(
      (line) => line.id === undefined && line.role === 'user' && line.content === message.content,
    );
    if (optimistic >= 0) {
      return [
        ...lines.slice(0, optimistic),
        messageToLine(message),
        ...lines.slice(optimistic + 1),
      ];
    }
  }
  return [...lines, messageToLine(message)];
}

/**
 * Fold a transcript snapshot into the rendered lines, appending any rows we don't
 * already have (by id) in order. Used for the initial load and the reconnect
 * re-sync that recovers rows appended while the channel was disconnected.
 */
function mergeSnapshot(lines: ChatLine[], history: readonly MessageDto[]): ChatLine[] {
  const known = new Set(lines.map((line) => line.id).filter((id): id is string => !!id));
  const additions = history.filter((message) => !known.has(message.id)).map(messageToLine);
  return additions.length > 0 ? [...lines, ...additions] : lines;
}

export function Chat({
  companion,
  onSignOut,
  onOpenMemory,
  onOpenSources,
  onOpenGrowth,
}: ChatProps): JSX.Element {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  // The companion is composing a server-initiated greeting (P14) — show a typing
  // indicator until it lands or the gate stays quiet.
  const [composing, setComposing] = useState(false);
  // Guards against overlapping arrival checks (mount + focus can both fire).
  const greetingRef = useRef(false);
  // Channel rows that arrived before the snapshot landed or while a turn is in
  // flight, held until it's safe to merge them (see the establishment effect).
  const bufferedRef = useRef<MessageDto[]>([]);
  // Mirrors of `ready`/`locked` the long-lived channel consumer reads — its closure
  // can't see fresh React state.
  const readyRef = useRef(false);
  const lockedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The multi-line composer, auto-grown to fit its content (see the effect below).
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Last seen status per ingestion job, to spot a job settling (→ done/failed)
  // across polls so we can pull in the companion's proactive note.
  const prevJobStatus = useRef<Map<string, IngestionStatus>>(new Map());
  // One poll for the whole chat surface, shared by the header badge and panel.
  const ingestion = useIngestionJobs(companion.id);
  // The pending approval queue (propose→approve, P3) — surfaced as cards below
  // the transcript; a turn that ends in a proposal triggers an immediate refresh.
  const proposalsCtl = useProposals(companion.id);
  // Tell the backend the user is present (P4) so the motivation engine can decide
  // whether/how to initiate; volatile and best-effort.
  usePresenceHeartbeat(companion.id);

  // While a send is streaming or a file is uploading, the composer is locked so
  // the two intake paths never overlap.
  const locked = busy || attaching;
  // Keep the refs the async channel consumer reads in step with render.
  readyRef.current = ready;
  lockedRef.current = locked;

  // Grow the composer with its content (Gemini-style), up to the CSS max-height,
  // then scroll. Runs on every input change — including the reset to '' after a
  // send, which snaps it back to a single row.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Establish the durable view (architecture.md §6): open the standing event
  // channel AND load the transcript snapshot. Subscribe-FIRST (live rows buffer
  // until the snapshot lands), then snapshot, then merge by id — so a row that
  // persists after the snapshot still arrives over the live channel, and the two
  // never drop or duplicate. The channel reconnects with backoff while mounted and
  // re-syncs on reconnect; everything aborts on unmount. This is what makes opening
  // the chat, navigating away and back, or a second tab all converge on the
  // transcript without a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    // Hold rows until the snapshot has landed and no turn is mid-flight (the
    // per-turn stream owns its optimistic lines until then); the buffer is flushed,
    // deduped by id, once it's safe (the effect below).
    const applyOrBuffer = (message: MessageDto): void => {
      if (!readyRef.current || lockedRef.current) {
        bufferedRef.current.push(message);
      } else {
        setLines((prev) => mergeMessage(prev, message));
      }
    };

    // The standing subscription, reconnecting until unmount.
    void (async () => {
      let backoff = CHANNEL_INITIAL_BACKOFF_MS;
      while (!cancelled) {
        try {
          for await (const message of subscribeMessages(companion.id, controller.signal)) {
            if (cancelled) break;
            applyOrBuffer(message);
            backoff = CHANNEL_INITIAL_BACKOFF_MS; // a healthy frame resets backoff
          }
        } catch (err) {
          if (cancelled || controller.signal.aborted) break;
          console.error('event channel error; reconnecting', {
            companionId: companion.id,
            error: err,
          });
        }
        if (cancelled) break;
        await delay(backoff);
        backoff = Math.min(backoff * 2, CHANNEL_MAX_BACKOFF_MS);
        if (cancelled) break;
        // Recover rows appended while we were disconnected (no server-side replay).
        try {
          const history = await fetchMessages(companion.id);
          if (!cancelled) setLines((prev) => mergeSnapshot(prev, history));
        } catch (err) {
          console.error('re-snapshot after reconnect failed', {
            companionId: companion.id,
            error: err,
          });
        }
      }
    })();

    // The initial snapshot, retried until it lands (a companion has one lifelong
    // conversation, so resuming is just loading its transcript).
    void (async () => {
      let backoff = CHANNEL_INITIAL_BACKOFF_MS;
      while (!cancelled) {
        try {
          const history = await fetchMessages(companion.id);
          if (cancelled) return;
          setLines((prev) =>
            prev.length > 0 ? mergeSnapshot(prev, history) : history.map(messageToLine),
          );
          setError(null);
          setReady(true);
          return;
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to load conversation');
          await delay(backoff);
          backoff = Math.min(backoff * 2, CHANNEL_MAX_BACKOFF_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [companion.id]);

  // Once the snapshot has landed and no turn is in flight, flush the rows the
  // channel buffered in the meantime (deduped by id against what's already shown).
  useEffect(() => {
    if (!ready || locked) return;
    if (bufferedRef.current.length === 0) return;
    const pending = bufferedRef.current;
    bufferedRef.current = [];
    setLines((prev) => pending.reduce(mergeMessage, prev));
  }, [ready, locked]);

  /**
   * Pull any transcript turns we don't already have and append them. Merged by
   * id, so re-fetching never duplicates lines already shown (every persisted
   * line carries its server id). Used to deliver the companion's proactive
   * "finished reading…" note into an already-open chat.
   */
  const refreshTranscript = useCallback(async (): Promise<void> => {
    try {
      const history = await fetchMessages(companion.id);
      setLines((prev) => mergeSnapshot(prev, history));
    } catch (err) {
      console.error('transcript refresh failed', { companionId: companion.id, error: err });
    }
  }, [companion.id]);

  /**
   * Ask the companion to react to the user's arrival (P14). The server decides
   * whether to greet from the durable last-seen gap; we just surface the result:
   * a `composing` cue flips on the typing indicator, then the voiced greeting
   * lands as its own assistant line (carrying the persisted message, so it never
   * duplicates a later refetch). Safe to call repeatedly — the server stays quiet
   * on a brief return — and the ref coalesces overlapping mount/focus calls.
   */
  const runGreeting = useCallback(async (): Promise<void> => {
    if (greetingRef.current) return;
    greetingRef.current = true;
    try {
      for await (const event_ of streamGreeting(companion.id)) {
        if (event_.type === 'composing') {
          setComposing(true);
        } else if (event_.type === 'done') {
          setLines((prev) => mergeMessage(prev, event_.message));
          setComposing(false);
        } else if (event_.type === 'error') {
          setComposing(false);
        }
      }
    } catch (err) {
      console.error('greeting failed', { companionId: companion.id, error: err });
    } finally {
      setComposing(false);
      greetingRef.current = false;
    }
  }, [companion.id]);

  // Arrival = the chat surface becoming present: once on mount (after the
  // transcript loads) and again whenever the tab is refocused after being away.
  useEffect(() => {
    if (ready) void runGreeting();
  }, [ready, runGreeting]);

  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState === 'visible') void runGreeting();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [runGreeting]);

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

  /**
   * Drive a streamed turn into the transcript: tokens grow the trailing
   * assistant bubble, citations attach to it, and read-only tool steps slot in
   * above it as they happen. Returns whether the turn produced "rich" rows
   * (tool steps or proposals) — when it did, the optimistic lines are an
   * approximation, so the caller reconciles against the persisted transcript.
   */
  const consumeTurn = useCallback(
    async (stream: AsyncGenerator<ChatStreamEvent>): Promise<boolean> => {
      let rich = false;
      for await (const event_ of stream) {
        if (event_.type === 'token') {
          setLines((prev) => appendToLast(prev, event_.value));
        } else if (event_.type === 'citations') {
          setLines((prev) => citeLast(prev, event_.citations));
        } else if (event_.type === 'tool_step') {
          // "Cobble looked something up" — show it above the reply as it happens.
          rich = true;
          setLines((prev) => insertStep(prev, event_.step));
        } else if (event_.type === 'done') {
          // The authoritative persisted reply (server id + final content) replaces
          // whatever the token deltas built, and gives the line a stable key.
          setLines((prev) => finalizeLast(prev, event_.message));
        } else if (event_.type === 'reflection') {
          // A growth reflection posted right after the reply (P5, "growth, felt").
          // Append it as its own assistant line; it carries the persisted message,
          // so its id matches a later refetch and never duplicates.
          setLines((prev) => mergeMessage(prev, event_.message));
        } else if (event_.type === 'proposal') {
          // The turn EXITed proposing an effectful action; it's now a transcript
          // row, and the live queue needs the pending entry for its Approve card.
          rich = true;
        } else if (event_.type === 'error') {
          setLines((prev) => appendToLast(prev, `\n[${event_.message}]`));
        }
      }
      return rich;
    },
    [],
  );

  /**
   * Replace the rendered lines with the persisted transcript — the single source
   * of truth. Called after a turn that produced tool steps or proposals, so the
   * conversation (ordering, grounding, proposal rows) is exactly what a reload
   * would show, not an optimistic approximation.
   */
  const reloadTranscript = useCallback(async (): Promise<void> => {
    const history = await fetchMessages(companion.id);
    setLines(history.map(messageToLine));
  }, [companion.id]);

  async function sendCurrentInput(): Promise<void> {
    if (!ready || input.trim().length === 0 || busy) return;
    const content = input.trim();
    setInput('');
    setBusy(true);
    setError(null);
    setLines((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }]);

    try {
      const rich = await consumeTurn(sendMessage(companion.id, content));
      if (rich) {
        await proposalsCtl.refresh();
        await reloadTranscript();
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

  async function onSend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await sendCurrentInput();
  }

  /**
   * Enter sends; Shift+Enter inserts a newline (Gemini-style multi-line compose).
   * IME composition is respected so confirming a candidate with Enter never fires
   * an accidental send.
   */
  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendCurrentInput();
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

  /**
   * Approve a held action. The companion executes it and RE-ENTERS the loop to
   * narrate the outcome and continue the task — streamed in like a normal turn —
   * so "remember this and summarize it" yields the summary, not a dead line.
   */
  async function onConfirmProposal(proposalId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Optimistic bubble for the streamed narration; the reload reconciles the
    // approved-action row and final ordering.
    setLines((prev) => [...prev, { role: 'assistant', content: '' }]);
    try {
      await consumeTurn(confirmProposal(companion.id, proposalId));
      await proposalsCtl.refresh();
      await reloadTranscript();
    } catch (err) {
      console.error('confirm failed', { companionId: companion.id, error: err });
      setLines((prev) => dropEmptyAssistantTail(prev));
      setError(err instanceof Error ? err.message : 'Failed to approve action');
    } finally {
      setBusy(false);
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
          <IngestionStatusButton
            activeCount={ingestion.active.length}
            onClick={() => setStatusOpen(true)}
          />
          <ProactivityDial companionId={companion.id} initial={companion.proactivityDial} />
          <BudgetMeter companionId={companion.id} />
          <button type="button" onClick={onOpenSources}>
            Sources
          </button>
          <button type="button" onClick={onOpenMemory}>
            Memory
          </button>
          <button type="button" onClick={onOpenGrowth}>
            Growth
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>
      {error && <p className="error">{error}</p>}
      <ul className="transcript">
        {lines.map((line, index) => {
          const key = line.id ?? index;
          // A read-only look-up: a muted, single-line "Cobble did X" note.
          if (line.kind === 'tool_step') {
            return (
              <li key={key} className="line tool-step">
                <span className="content">🔍 {line.content}</span>
              </li>
            );
          }
          // A held effectful action — a log entry in the conversation. The live
          // Approve/Decline affordance is the queue card below while it's pending.
          if (line.kind === 'proposal') {
            return (
              <li key={key} className="line proposal-line">
                <span className="content">📋 Proposed: {line.content}</span>
              </li>
            );
          }
          return (
            <li key={key} className={`line ${line.role}${line.attachment ? ' attachment' : ''}`}>
              <span className="who">{line.role === 'user' ? 'You' : companion.name}</span>
              <span className="content">
                {line.attachment ? (
                  `📎 ${line.content}`
                ) : line.role === 'assistant' ? (
                  // The companion replies in Markdown; render it formatted. User
                  // turns stay literal so typed asterisks/backticks show as typed.
                  <MarkdownMessage content={line.content} />
                ) : (
                  line.content
                )}
              </span>
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
          );
        })}
        {composing && (
          <li className="line assistant composing" aria-live="polite">
            <span className="who">{companion.name}</span>
            <span className="content">…</span>
          </li>
        )}
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
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={`Message ${companion.name}…`}
            disabled={locked || !ready}
            rows={1}
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
 * Slot a read-only tool step in ABOVE the trailing assistant bubble, so the
 * "looked something up" note appears before the reply it informed (matching the
 * transcript's seq order after a reload).
 */
function insertStep(lines: ChatLine[], step: MessageDto): ChatLine[] {
  const line = messageToLine(step);
  if (lines.length === 0) return [line];
  return [...lines.slice(0, -1), line, lines[lines.length - 1]!];
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
