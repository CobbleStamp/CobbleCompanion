/**
 * Proactive DMs + the arrival greeting (companion-discord.md §8): while Active, the
 * bridge forwards the companion's *autonomous* messages to the owner as DMs, and on
 * `/summon` it streams the arrival greeting.
 *
 * Gating is **server-side**: the motivation engine already respects the companion's
 * `proactivity_dial` (off → it produces no autonomous messages), so the bridge simply
 * forwards whatever autonomous messages arrive — there is no client-side dial check
 * (plans/discord-surface.md D4). The connection's live-event stream is de-duped against
 * turn replies the bridge already rendered (D5), so a chat reply is never re-posted here.
 *
 * Depends only on the {@link CompanionConnection} seam — nothing from `@cobble/core`.
 */

import type { CompanionConnection } from './bridge.js';
import type { Logger } from './gateway/types.js';

/** Post a proactive / greeting DM (the bridge supplies a channel-bound sender). */
export type PostMessage = (content: string) => Promise<void>;

interface LogContext {
  readonly operation: string;
  readonly userId: string;
}

/**
 * Stream the arrival greeting (`greeting.stream`) and post it once — only if the
 * companion actually greets (the stream is empty when it decides not to). A failure is
 * logged and surfaced as its user-facing notice if any; there is no empty fallback (a
 * non-greeting must stay silent).
 */
export async function streamGreeting(
  connection: CompanionConnection,
  post: PostMessage,
  logger: Logger,
  log: LogContext,
): Promise<void> {
  try {
    for await (const event of connection.greeting()) {
      if (event.type === 'done' && event.message.content.trim().length > 0) {
        await post(event.message.content);
      } else if (event.type === 'error' && event.message.trim().length > 0) {
        await post(event.message);
      }
    }
  } catch (error) {
    logger.error('discord greeting failed', { ...log, error });
  }
}

/**
 * Forward the companion's autonomous messages as DMs until `signal` aborts (the bridge
 * aborts on teardown / supersession). A non-abort failure is logged; an abort ends the
 * loop quietly.
 */
export async function runProactiveLoop(
  connection: CompanionConnection,
  post: PostMessage,
  logger: Logger,
  log: LogContext,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of connection.events(signal)) {
      if (
        event.type === 'message' &&
        event.message.role === 'assistant' &&
        event.message.content.trim().length > 0
      ) {
        await post(event.message.content);
      }
    }
  } catch (error) {
    if (signal.aborted) return; // expected teardown
    logger.error('discord proactive loop failed', { ...log, error });
  }
}
