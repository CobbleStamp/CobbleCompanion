/**
 * The mission advance turn (companion-missions.md §3.4): a trigger (or a chat message)
 * wakes the companion, which runs `mission.advance` over the embodiment connection and
 * speaks its report into the embodied room. Like {@link handleChat}, the stream is consumed
 * server-side into Discord output by the shared {@link renderTurnStream}.
 *
 * This is the `onMissionAdvance` hook the bridge calls. It depends only on the
 * {@link CompanionConnection} seam — nothing from `@cobble/core`.
 */

import type { CompanionConnection } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { renderTurnStream } from './turn-render.js';

/** Run one mission advance turn and post the companion's report to the owner's DM. */
export async function handleAdvance(
  connection: CompanionConnection,
  post: (content: string) => Promise<void>,
  event: string,
  logger: Logger,
  userId: string,
): Promise<void> {
  await renderTurnStream(
    connection.callStream('mission.advance', { event }),
    {
      // A background mission report needs no "typing…" cue in the DM.
      typing: async () => {},
      reply: (content) => post(content),
      // v1 missions are read-only (companion-missions.md §4): no effectful tool, so no
      // proposal card is expected. If one ever appears, log it rather than dropping silently.
      sendProposal: async (card) => {
        logger.warn('mission advance produced a proposal (v1 missions are read-only); skipping', {
          operation: 'discord.advance',
          userId,
          toolName: card.toolName,
        });
      },
    },
    logger,
    { operation: 'discord.advance', userId },
  );
}
