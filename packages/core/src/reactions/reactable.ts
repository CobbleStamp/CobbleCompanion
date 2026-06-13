/**
 * What a user reaction may attach to (companion-reactions.md §3): only the
 * companion's own `message`-kind turns. Tool-step / proposal chrome is not a
 * reward target, and the user's own words must never be read for the value the
 * companion created. The constraint lives in the type: parse a fetched row once
 * at the boundary, and everything downstream ({@link ReactionLearner.learn})
 * accepts only the proof-carrying result — not a bare id it would have to
 * re-fetch and re-judge.
 */

import type { MessageDto } from '@cobble/shared';

/** A transcript row a user reaction may attach to — the companion's own
 *  `message`-kind turn, proven by {@link asReactableMessage}. */
export type ReactableMessage = MessageDto & {
  readonly role: 'assistant';
  readonly kind?: 'message';
};

/** Parse a fetched row into a reactable one — `null` when it is chrome
 *  (`tool_step` / `proposal`) or not an assistant turn. */
export function asReactableMessage(message: MessageDto): ReactableMessage | null {
  return message.role === 'assistant' && (message.kind ?? 'message') === 'message'
    ? (message as ReactableMessage)
    : null;
}
