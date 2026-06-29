/**
 * Approvals over Discord (companion-discord.md §7): a held effectful action surfaces in
 * the DM as a proposal embed + Confirm/Reject buttons (rendered by the chat turn via
 * `turn-render.ts`). This module handles the button click — the bridge's
 * `onProposalAction` hook, invoked only while embodied (the proposal methods are
 * companion-scoped, so they need the live claim).
 *
 * - **Confirm** → `proposals.confirm` (streamed; the post-approval turn renders exactly
 *   like a chat reply, §5).
 * - **Reject** → `proposals.reject`; the original embed is updated to mark it declined.
 *
 * Keeping approvals in Discord is required, not cosmetic: approving on the web app would
 * force-claim the companion and supersede the bot (§4). It depends only on the
 * {@link CompanionConnection} seam and the manager context — nothing from `@cobble/core`.
 */

import type { CompanionConnection } from './bridge.js';
import type { ProposalActionContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import { renderTurnStream } from './turn-render.js';

const GENERIC_ERROR = 'Something went wrong on my end — give me a moment and try again.';
const REJECTED = 'Okay — I won’t go ahead with that.';
const GONE = 'That one’s no longer waiting — it may have already been handled.';

/** Handle a Confirm/Reject click over the (summoned) connection. */
export async function handleProposalAction(
  ctx: ProposalActionContext,
  connection: CompanionConnection,
  logger: Logger,
): Promise<void> {
  if (ctx.action === 'reject') {
    try {
      await connection.call('proposals.reject', { proposalId: ctx.proposalId });
      await ctx.update(REJECTED);
    } catch (error) {
      logger.error('discord proposal reject failed', {
        operation: 'discord.proposal.reject',
        userId: ctx.userId,
        proposalId: ctx.proposalId,
        error,
      });
      await ctx.reply(GENERIC_ERROR);
    }
    return;
  }

  // Confirm: mark the card resolved, then stream the post-approval turn like a chat reply.
  await ctx.update('Confirmed — on it. ✅');
  await renderTurnStream(
    confirmStream(connection, ctx.proposalId),
    {
      typing: () => ctx.typing(),
      reply: (content) => ctx.reply(content),
      sendProposal: (card) => ctx.sendProposal(card),
    },
    logger,
    { operation: 'discord.proposal.confirm', userId: ctx.userId },
  );
}

/**
 * Stream `proposals.confirm`. A `conflict` (the proposal is no longer pending — e.g.
 * already resolved) is the one expected, user-actionable failure: surface a friendly
 * note rather than the generic error. Everything else propagates to the renderer.
 */
async function* confirmStream(
  connection: CompanionConnection,
  proposalId: string,
): AsyncIterable<import('@cobble/shared').ChatStreamEvent> {
  try {
    yield* connection.callStream('proposals.confirm', { proposalId });
  } catch (error) {
    if (isConflict(error)) {
      yield { type: 'error', message: GONE };
      return;
    }
    throw error;
  }
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'conflict'
  );
}
