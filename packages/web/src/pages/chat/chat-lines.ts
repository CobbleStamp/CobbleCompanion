/**
 * The rendered-transcript model and the pure functions that fold server rows,
 * channel events, and streamed turn deltas into it. Extracted from Chat.tsx so the
 * page component, the `useEmbodimentSync` hook (snapshot/channel merges), and the
 * `<ChatTranscript>` view all share one definition of a line and one set of
 * merge/reduce rules — none of these touch React, so they unit-test in isolation.
 */

import type {
  Citation,
  CompanionStreamEvent,
  MessageDto,
  MessageKind,
  MessageRole,
  ReactionDto,
  StreamReactionAddedEvent,
  StreamReactionRemovedEvent,
} from '@cobble/shared';

export interface ChatLine {
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
  /**
   * Emoji reactions on this line (companion-reactions.md §8) — the user's on the
   * companion's messages, and the companion's on the user's. Joined onto the
   * snapshot and kept current by live `reaction_*` channel events.
   */
  readonly reactions?: readonly ReactionDto[];
}

/**
 * Rebuild a transcript line from a persisted message. The 📎 chip and the
 * "View status →" link are derived purely from `role` + `sourceId`, so a turn
 * loaded on mount looks identical to the optimistic one shown right after upload.
 */
export function messageToLine(m: MessageDto): ChatLine {
  const kind = m.kind ?? 'message';
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    kind,
    ...(m.metadata?.citations ? { citations: m.metadata.citations } : {}),
    ...(m.metadata?.proposalId ? { proposalId: m.metadata.proposalId } : {}),
    ...(m.sourceId !== null ? { sourceId: m.sourceId } : {}),
    ...(m.reactions && m.reactions.length > 0 ? { reactions: m.reactions } : {}),
    attachment: m.role === 'user' && m.sourceId !== null,
  };
}

/**
 * Apply a live reaction event to the rendered lines (companion-reactions.md §8):
 * add/remove the emoji on the matching message. Idempotent — re-adding an emoji
 * already present, or removing one already gone, is a no-op (so an optimistic
 * update and its channel echo converge). A target not currently rendered is
 * dropped (its reactions ride the snapshot when it loads).
 */
export function applyReaction(
  lines: ChatLine[],
  event: StreamReactionAddedEvent | StreamReactionRemovedEvent,
): ChatLine[] {
  const index = lines.findIndex((line) => line.id === event.messageId);
  if (index < 0) return lines;
  const line = lines[index]!;
  const current = line.reactions ?? [];
  const present = current.some((r) => r.reactor === event.reactor && r.emoji === event.emoji);
  if (event.type === 'reaction_added' ? present : !present) return lines;
  const reactions: readonly ReactionDto[] =
    event.type === 'reaction_added'
      ? [...current, { messageId: event.messageId, reactor: event.reactor, emoji: event.emoji }]
      : current.filter((r) => !(r.reactor === event.reactor && r.emoji === event.emoji));
  return [...lines.slice(0, index), { ...line, reactions }, ...lines.slice(index + 1)];
}

/**
 * Whether two reaction sets are equal as sets, order-independent and keyed by
 * reactor+emoji (a message can't carry the same pair twice). Lets
 * {@link mergeMessage} adopt a snapshot's authoritative reactions for an
 * already-rendered row only when they actually differ, so an idle re-sync still
 * returns the unchanged array reference and doesn't churn.
 */
export function reactionsEqual(a: readonly ReactionDto[], b: readonly ReactionDto[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: ReactionDto): string => `${r.reactor}:${r.emoji}`;
  const seen = new Set(a.map(key));
  return b.every((r) => seen.has(key(r)));
}

/**
 * Merge one pushed/persisted row into the rendered lines, keyed by server id
 * (architecture.md §6). Already present by id → reconcile its reactions: the row's
 * content is immutable, but reactions are a mutable overlay (companion-reactions.md
 * §8) and the snapshot is authoritative, so a re-sync must adopt the server's set
 * (the only repair path for a reaction whose live channel echo was lost — the bus
 * carries no replay). Unchanged reactions return the same array reference, so the
 * idle re-sync stays a no-op. Otherwise reconcile the optimistic, id-less echo of a
 * row this client just sent — a user line matched by content — by adopting the
 * authoritative row in place; a genuinely new row is appended (the channel and
 * snapshot both deliver in chronological order).
 */
export function mergeMessage(lines: ChatLine[], message: MessageDto): ChatLine[] {
  const present = lines.findIndex((line) => line.id === message.id);
  if (present >= 0) {
    const line = lines[present]!;
    const server = message.reactions ?? [];
    if (reactionsEqual(line.reactions ?? [], server)) return lines;
    const { reactions: _dropped, ...rest } = line;
    const reconciled: ChatLine = server.length > 0 ? { ...rest, reactions: server } : rest;
    return [...lines.slice(0, present), reconciled, ...lines.slice(present + 1)];
  }
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
 * Fold a transcript snapshot into the rendered lines in order. Each row goes
 * through {@link mergeMessage}, so a row already present by id is a no-op and the
 * id-less optimistic echo of a just-sent user line is reconciled in place rather
 * than duplicated — the snapshot is the only delivery path for a row whose live
 * channel echo was lost (the channel was disconnected when it persisted, and the
 * bus carries no replay). Used for the initial load and the reconnect / tab-return
 * re-sync that recovers rows appended while the channel was down. Returns the same
 * array reference when the snapshot adds nothing, so an idle re-sync doesn't churn.
 */
export function mergeSnapshot(lines: ChatLine[], history: readonly MessageDto[]): ChatLine[] {
  return history.reduce(mergeMessage, lines);
}

/** Fold one channel event into the lines: a `message` merges by id, a `reaction_*`
 *  mutates its target message's reaction set. The single reducer the live channel
 *  and the buffered-flush both apply. */
export function reduceEvent(lines: ChatLine[], event: CompanionStreamEvent): ChatLine[] {
  return event.type === 'message'
    ? mergeMessage(lines, event.message)
    : applyReaction(lines, event);
}

export function appendToLast(lines: ChatLine[], delta: string): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), { ...last, content: last.content + delta }];
}

export function citeLast(lines: ChatLine[], citations: readonly Citation[]): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), { ...last, citations }];
}

/**
 * Slot a read-only tool step in ABOVE the trailing assistant bubble, so the
 * "looked something up" note appears before the reply it informed (matching the
 * transcript's seq order after a reload).
 */
export function insertStep(lines: ChatLine[], step: MessageDto): ChatLine[] {
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
export function finalizeLast(lines: ChatLine[], message: MessageDto): ChatLine[] {
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
export function dropEmptyAssistantTail(lines: ChatLine[]): ChatLine[] {
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
export function dropAttachmentTail(lines: ChatLine[]): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  if (last.attachment) return lines.slice(0, -1);
  return lines;
}

/** Collapse repeated passages from the same source span into one chip. */
export function dedupeCitations(citations: readonly Citation[]): readonly Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.sourceId}:${citation.paraStart}-${citation.paraEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "Peru book (ch. 4, para 12–18)" — human-readable, locatable provenance. */
export function formatCitation(citation: Citation): string {
  const parts = [
    citation.chapterTitle ? `ch. ${citation.chapterTitle}` : null,
    `para ${citation.paraStart}–${citation.paraEnd}`,
    citation.pageStart !== null ? `p. ${citation.pageStart}` : null,
  ].filter((part): part is string => part !== null);
  return `${citation.sourceTitle} (${parts.join(', ')})`;
}
