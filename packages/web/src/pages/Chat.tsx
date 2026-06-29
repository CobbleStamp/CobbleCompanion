/**
 * The chat surface: the companion's single continuous, streamed conversation.
 * Grounded turns render their citations ("Grounded in: …") under the assistant's
 * reply so the user always sees where an answer came from. This component owns the
 * turn-streaming + compose concerns; the durable view (channel/snapshot/reconnect)
 * lives in {@link useEmbodimentSync}, the line model + merge rules in `chat-lines.ts`,
 * and the transcript / composer rendering in their own components.
 */

import type { ChatStreamEvent, CompanionDto } from '@cobble/shared';
import { fileSourceAcknowledgement, uploadKindForFilename } from '@cobble/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addReaction,
  confirmProposal,
  fetchMessages,
  removeReaction,
  sendMessage,
  streamGreeting,
  uploadFileSource,
} from '../api/client.js';
import { BudgetMeter } from '../components/BudgetMeter.js';
import { IngestionPanel } from '../components/IngestionPanel.js';
import { IngestionStatusButton } from '../components/IngestionStatusButton.js';
import { Modal } from '../components/Modal.js';
import { MovedAway } from '../components/MovedAway.js';
import { ProactivityDial } from '../components/ProactivityDial.js';
import { ProposalCard } from '../components/ProposalCard.js';
import { useIngestionJobs } from '../components/useIngestionJobs.js';
import { usePresenceHeartbeat } from '../components/usePresenceHeartbeat.js';
import { useProposals } from '../components/useProposals.js';
import { ChatComposer } from './chat/ChatComposer.js';
import { ChatTranscript } from './chat/ChatTranscript.js';
import {
  appendToLast,
  citeLast,
  dropAttachmentTail,
  dropEmptyAssistantTail,
  finalizeLast,
  insertStep,
  applyReaction,
  mergeMessage,
  messageToLine,
  type ChatLine,
} from './chat/chat-lines.js';
import { useEmbodimentSync } from './chat/useEmbodimentSync.js';

interface ChatProps {
  readonly companion: CompanionDto;
  readonly onSignOut: () => void;
  readonly onOpenMemory: () => void;
  readonly onOpenSources: () => void;
  readonly onOpenGrowth: () => void;
  readonly onOpenActivity: () => void;
  readonly onOpenDiscord: () => void;
}

export function Chat({
  companion,
  onSignOut,
  onOpenMemory,
  onOpenSources,
  onOpenGrowth,
  onOpenActivity,
  onOpenDiscord,
}: ChatProps): JSX.Element {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  // The companion is composing a server-initiated greeting (P14) — show a typing
  // indicator until it lands or the gate stays quiet.
  const [composing, setComposing] = useState(false);
  // Guards against overlapping arrival checks (mount + focus can both fire).
  const greetingRef = useRef(false);

  // While a send is streaming or a file is uploading, the composer is locked so the
  // two intake paths never overlap. (A moved room renders the full-screen MovedAway
  // takeover instead of the composer, so it needn't gate `locked`.)
  const locked = busy || attaching;

  // The durable view (architecture.md §6): the standing channel + transcript snapshot
  // + reconnect + buffer + room-takeover. It owns the rendered `lines`; the turn
  // streaming below writes its optimistic lines through `setLines`.
  const { lines, setLines, ready, moved, onMoveHere, refreshTranscript } = useEmbodimentSync(
    companion.id,
    locked,
    setError,
  );

  // One poll for the whole chat surface, shared by the header badge and panel.
  const ingestion = useIngestionJobs(companion.id);
  // The pending approval queue (propose→approve, P3) — surfaced as cards below
  // the transcript; a turn that ends in a proposal triggers an immediate refresh.
  const proposalsCtl = useProposals(companion.id);
  // Tell the backend the user is present (P4) so the motivation engine can decide
  // whether/how to initiate; volatile and best-effort.
  usePresenceHeartbeat(companion.id);

  // Toggle a user reaction on one of the companion's messages (companion-reactions.md
  // §8): optimistically flip it for instant feedback, fire the API call, and let the
  // server's `reaction_*` echo over the channel confirm it (a no-op under idempotent
  // `applyReaction`). On failure, reconcile against the server rather than blindly
  // flipping back — a rejected request may have committed server-side with only its
  // response lost, so a blind rollback would leave the client permanently disagreeing
  // with the server (now repairable, since mergeMessage adopts the snapshot's set).
  const toggleReaction = useCallback(
    (messageId: string, emoji: string): void => {
      const line = lines.find((candidate) => candidate.id === messageId);
      const has = line?.reactions?.some((r) => r.reactor === 'user' && r.emoji === emoji) ?? false;
      const flip = (added: boolean): void =>
        setLines((prev) =>
          applyReaction(prev, {
            type: added ? 'reaction_added' : 'reaction_removed',
            messageId,
            reactor: 'user',
            emoji,
          }),
        );
      flip(!has);
      const action = has
        ? removeReaction(companion.id, messageId, emoji)
        : addReaction(companion.id, messageId, emoji);
      action.catch((err) => {
        console.error('reaction toggle failed', { messageId, emoji, error: err });
        void refreshTranscript(); // adopt server truth instead of assuming the flip failed
      });
    },
    [lines, setLines, companion.id, refreshTranscript],
  );

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
  }, [companion.id, setLines]);

  // Arrival = the chat surface becoming present: once on mount (after the
  // transcript loads) and again whenever the tab is refocused after being away.
  useEffect(() => {
    if (ready) void runGreeting();
  }, [ready, runGreeting]);

  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState !== 'visible') return;
      // Re-sync the transcript (cheap, id-deduped) in case the standing channel
      // dropped while the tab was hidden, then run the arrival greeting.
      void refreshTranscript();
      void runGreeting();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [refreshTranscript, runGreeting]);

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
    [setLines],
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
  }, [companion.id, setLines]);

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

  // The room moved to another tab/device: take over the whole surface with the
  // MovedAway screen until the user moves the companion back here. Rendered after all
  // hooks so the establishment effect (and its onEmbodimentMoved listener) stays
  // mounted — "Move here" re-runs it to force-claim the room back.
  if (moved) {
    return <MovedAway companionName={companion.name} onMoveHere={onMoveHere} />;
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
          <button type="button" onClick={onOpenActivity}>
            Activity
          </button>
          <button type="button" onClick={onOpenDiscord}>
            Discord
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>
      {error && <p className="error">{error}</p>}
      <ChatTranscript
        lines={lines}
        companionName={companion.name}
        composing={composing}
        onToggleReaction={toggleReaction}
        onOpenStatus={() => setStatusOpen(true)}
      />
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
      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={() => void sendCurrentInput()}
        onAttach={(file) => void onAttach(file)}
        disabled={locked || !ready}
        placeholder={`Message ${companion.name}…`}
      />
    </main>
  );
}
