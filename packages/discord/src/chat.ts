/**
 * The chat turn (companion-discord.md §5): an owner DM while summoned runs
 * `messages.send` over the embodiment connection, and the stream is consumed
 * **server-side** into a single Discord reply — Discord is rate-limited and not built
 * for token-by-token streaming. The `composing` cue drives the "typing…" indicator;
 * the `done` message is posted as one message; a mid-turn `error` event posts its
 * (already user-facing) text; an `over_cap` rejection becomes a `/feed` nudge.
 *
 * This is the `onChat` hook the bridge calls (T8 wired the seam). It depends only on
 * the {@link CompanionConnection} seam and the router context — nothing from
 * `@cobble/core`.
 */

import type { DirectMessageContext } from './gateway/manager.js';
import type { Logger } from './gateway/types.js';
import type { CompanionConnection } from './bridge.js';
import { WsCallError } from './ws-client.js';

const TIRED_NUDGE = 'I’m a little tired — `/feed` me and I’ll pick this back up.';
const GENERIC_ERROR = 'Something went wrong on my end — give me a moment and try again.';
const EMPTY_REPLY = 'I don’t have anything to add to that.';

/** Run one chat turn and post the companion's reply as a single DM. */
export async function handleChat(
  ctx: DirectMessageContext,
  connection: CompanionConnection,
  logger: Logger,
): Promise<void> {
  let finalContent: string | null = null;
  let errorText: string | null = null;
  try {
    for await (const event of connection.chat(ctx.message.content)) {
      switch (event.type) {
        case 'composing':
          await ctx.typing();
          break;
        case 'done':
          finalContent = event.message.content;
          break;
        case 'error':
          // Already a user-facing notice (turn failure / companion unavailable).
          errorText = event.message;
          break;
        // token / citations / tool_step / proposal / reflection: not rendered in the
        // single-message turn (citations/proposals get richer treatment in T10/T11).
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof WsCallError && error.code === 'over_cap') {
      await ctx.reply(TIRED_NUDGE);
      return;
    }
    logger.error('discord chat turn failed', {
      operation: 'discord.chat',
      userId: ctx.userId,
      error,
    });
    await ctx.reply(GENERIC_ERROR);
    return;
  }

  if (errorText && errorText.trim().length > 0) {
    await ctx.reply(errorText);
    return;
  }
  await ctx.reply(finalContent && finalContent.trim().length > 0 ? finalContent : EMPTY_REPLY);
}
