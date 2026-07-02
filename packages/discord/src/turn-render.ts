/**
 * The shared turn-stream renderer (companion-discord.md §5): consume a
 * `ChatStreamEvent` stream **server-side** into Discord output. Both the chat turn
 * (`chat.ts`, an owner DM → `messages.send`) and the post-approval turn
 * (`proposals.ts`, a Confirm → `proposals.confirm`) render the same way — Discord is
 * rate-limited and not built for token-by-token streaming, so we buffer and post once.
 *
 * - `composing` → the "typing…" cue.
 * - `proposal` → a proposal embed + Confirm/Reject buttons (one per held proposal).
 * - `done` → a single final message, UNLESS its text only restates a proposal we
 *   already carded (the harness terminates a held turn with the proposal summary when
 *   the companion didn't also speak — `harness.ts` finishBlocked).
 * - `error` → its (already user-facing) text.
 * - `over_cap` rejection → the `/feed` nudge.
 * - token / citations / tool_step / reflection → buffered, not rendered.
 *
 * It depends only on the gateway seam shapes and `@cobble/shared` — nothing from
 * `@cobble/core`.
 */

import type { ChatStreamEvent } from '@cobble/shared';
import type { Logger, ProposalCard } from './gateway/types.js';
import { WsCallError } from './ws-client.js';

const TIRED_NUDGE = 'I’m a little tired — `/feed` me and I’ll pick this back up.';
const GENERIC_ERROR = 'Something went wrong on my end — give me a moment and try again.';
const EMPTY_REPLY = 'I don’t have anything to add to that.';

/** The Discord surface a turn renders onto (a DM reply, typing cue, proposal card). */
export interface TurnSurface {
  typing(): Promise<void>;
  reply(content: string): Promise<void>;
  sendProposal(card: ProposalCard): Promise<void>;
}

/** Per-call rendering knobs (see {@link renderTurnStream}). */
export interface RenderTurnOptions {
  /**
   * Post the "nothing to add" fallback when the turn produced no output (default true).
   * An interactive turn (the owner asked something) owes a reply; a background turn (a
   * mission wake) does not — an empty background turn should be silence, not chatter.
   */
  readonly emptyFallback?: boolean;
}

/** Consume a turn stream and render it to {@link TurnSurface} as a single reply (+ cards). */
export async function renderTurnStream(
  stream: AsyncIterable<ChatStreamEvent>,
  surface: TurnSurface,
  logger: Logger,
  log: { readonly operation: string; readonly userId: string },
  options: RenderTurnOptions = {},
): Promise<void> {
  let finalContent: string | null = null;
  let errorText: string | null = null;
  const cardedSummaries = new Set<string>();
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'composing':
          await surface.typing();
          break;
        case 'proposal':
          cardedSummaries.add(event.proposal.summary);
          await surface.sendProposal({
            proposalId: event.proposal.id,
            toolName: event.proposal.toolName,
            summary: event.proposal.summary,
          });
          break;
        case 'done':
          finalContent = event.message.content;
          break;
        case 'error':
          errorText = event.message;
          break;
        // token / citations / tool_step / reflection: not rendered in the single turn.
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof WsCallError && error.code === 'over_cap') {
      await surface.reply(TIRED_NUDGE);
      return;
    }
    logger.error('discord turn failed', { ...log, error });
    await surface.reply(GENERIC_ERROR);
    return;
  }

  if (errorText && errorText.trim().length > 0) {
    await surface.reply(errorText);
    return;
  }
  // Post the spoken words when the companion said something beyond the proposal(s).
  if (finalContent && finalContent.trim().length > 0 && !cardedSummaries.has(finalContent)) {
    await surface.reply(finalContent);
    return;
  }
  // Otherwise the proposal card(s) ARE the message; only fall back when there were none
  // (and the caller expects a reply at all — background turns render silence instead).
  if (cardedSummaries.size === 0 && (options.emptyFallback ?? true)) {
    await surface.reply(EMPTY_REPLY);
  }
}
