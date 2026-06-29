/**
 * The chat turn (companion-discord.md §5): an owner DM while summoned runs
 * `messages.send` over the embodiment connection, and the stream is consumed
 * **server-side** into a single Discord reply (+ any proposal cards) by the shared
 * {@link renderTurnStream}.
 *
 * This is the `onChat` hook the bridge calls (T8 wired the seam). It depends only on
 * the {@link CompanionConnection} seam and the router context — nothing from
 * `@cobble/core`.
 */

import type { DirectMessageContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import type { CompanionConnection } from './bridge.js';
import { renderTurnStream } from './turn-render.js';

/** Run one chat turn and post the companion's reply (and any proposals) as DMs. */
export async function handleChat(
  ctx: DirectMessageContext,
  connection: CompanionConnection,
  logger: Logger,
): Promise<void> {
  await renderTurnStream(
    connection.chat(ctx.message.content),
    {
      typing: () => ctx.typing(),
      reply: (content) => ctx.reply(content),
      sendProposal: (card) => ctx.sendProposal(card),
    },
    logger,
    { operation: 'discord.chat', userId: ctx.userId },
  );
}
