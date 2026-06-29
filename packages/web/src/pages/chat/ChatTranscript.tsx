/**
 * The rendered transcript: the scrolling list of chat lines (ordinary turns,
 * tool-step notes, proposal log entries, file chips with grounding + reactions) and
 * the composing indicator. Presentational — it takes the folded `lines` and callbacks
 * and renders; all state lives in the page / `useEmbodimentSync`.
 */

import { MarkdownMessage } from '../../components/MarkdownMessage.js';
import { dedupeCitations, formatCitation, type ChatLine } from './chat-lines.js';

/** The curated one-tap reactions — a shortcut, not a constraint (§7). */
const QUICK_REACTIONS = ['❤️', '👍', '😂', '🎉', '😮', '😢', '🙏', '👎'] as const;

/**
 * A message's reactions: existing chips (both reactors), plus — on the companion's
 * own messages — a quick-react bar so the user can react. The user reacts only to
 * the companion's turns; their own turns show the companion's reactions read-only.
 */
function MessageReactions({
  line,
  onToggle,
}: {
  readonly line: ChatLine;
  readonly onToggle: (emoji: string) => void;
}): JSX.Element | null {
  const reactions = line.reactions ?? [];
  const canReact = line.role === 'assistant' && line.id !== undefined;
  if (reactions.length === 0 && !canReact) return null;
  const mine = new Set(
    reactions.filter((reaction) => reaction.reactor === 'user').map((reaction) => reaction.emoji),
  );
  return (
    <span className="reactions">
      {reactions.map((reaction) => (
        <button
          key={`${reaction.reactor}-${reaction.emoji}`}
          type="button"
          className={`reaction-chip${reaction.reactor === 'user' ? ' mine' : ''}`}
          onClick={canReact ? () => onToggle(reaction.emoji) : undefined}
          disabled={!canReact}
          aria-label={`${reaction.reactor === 'user' ? 'You' : 'Companion'} reacted ${reaction.emoji}`}
        >
          {reaction.emoji}
        </button>
      ))}
      {canReact && (
        <span className="quick-react">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`quick-react-btn${mine.has(emoji) ? ' active' : ''}`}
              onClick={() => onToggle(emoji)}
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export interface ChatTranscriptProps {
  readonly lines: readonly ChatLine[];
  readonly companionName: string;
  readonly composing: boolean;
  readonly onToggleReaction: (messageId: string, emoji: string) => void;
  readonly onOpenStatus: () => void;
}

export function ChatTranscript({
  lines,
  companionName,
  composing,
  onToggleReaction,
  onOpenStatus,
}: ChatTranscriptProps): JSX.Element {
  return (
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
            <span className="who">{line.role === 'user' ? 'You' : companionName}</span>
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
              <button type="button" className="link-button" onClick={onOpenStatus}>
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
            <MessageReactions
              line={line}
              onToggle={(emoji) => line.id && onToggleReaction(line.id, emoji)}
            />
          </li>
        );
      })}
      {composing && (
        <li className="line assistant composing" aria-live="polite">
          <span className="who">{companionName}</span>
          <span className="content">…</span>
        </li>
      )}
    </ul>
  );
}
