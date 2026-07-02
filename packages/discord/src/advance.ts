/**
 * The mission advance turn (companion-missions.md §3.4): a trigger (or a chat message)
 * wakes the companion, which runs `mission.advance` over the embodiment connection and
 * speaks its report into the embodied room. Like {@link handleChat}, the stream is consumed
 * server-side into Discord output by the shared {@link renderTurnStream} — but as a
 * BACKGROUND turn: an empty stream renders silence (no "nothing to add" chatter in the DM),
 * and the method's terminal result is checked for the server's skip flag (the named
 * mission is unknown or no longer active — a stale trigger) so the bridge can undo a
 * summon the trigger caused.
 *
 * This is the `onMissionAdvance` hook the bridge calls. It depends only on the
 * {@link CompanionConnection} seam — nothing from `@cobble/core`.
 */

import { missionAdvanceResultSchema, type ChatStreamEvent } from '@cobble/shared';
import type { CompanionConnection, MissionAdvanceOutcome } from './bridge.js';
import type { Logger } from './gateway/types.js';
import { renderTurnStream } from './turn-render.js';

/** Run one advance turn for the NAMED mission, post the companion's report to the owner's
 *  DM, and report whether the server skipped the wake (stale trigger — mission not active). */
export async function handleAdvance(
  connection: CompanionConnection,
  post: (content: string) => Promise<void>,
  missionId: string,
  event: string,
  logger: Logger,
  userId: string,
): Promise<MissionAdvanceOutcome> {
  // The terminal result rides the stream generator's return value; `yield*` forwards
  // the chunks to the renderer while capturing it. A turn that errors mid-stream never
  // reaches the capture — `result` stays undefined and the outcome is "not skipped".
  let result: unknown;
  const stream = connection.callStream('mission.advance', { missionId, event });
  async function* captureResult(): AsyncGenerator<ChatStreamEvent, void> {
    result = yield* stream;
  }
  await renderTurnStream(
    captureResult(),
    {
      // A background mission report needs no "typing…" cue in the DM.
      typing: async () => {},
      reply: (content) => post(content),
      // Missions are read-only end to end (companion-missions.md §7): no effectful tool, so
      // no proposal card is expected. If one ever appears, log it rather than dropping silently.
      sendProposal: async (card) => {
        logger.warn('mission advance produced a proposal (missions are read-only); skipping', {
          operation: 'discord.advance',
          userId,
          toolName: card.toolName,
        });
      },
    },
    logger,
    { operation: 'discord.advance', userId },
    // Background turn: an empty stream is silence, never the "nothing to add" fallback.
    { emptyFallback: false },
  );
  const parsed = missionAdvanceResultSchema.safeParse(result);
  const skipped = parsed.success && parsed.data.skipped !== undefined;
  if (skipped) {
    logger.info('mission advance skipped by the server (mission not active)', {
      operation: 'discord.advance',
      userId,
      missionId,
    });
  }
  return { skipped };
}
