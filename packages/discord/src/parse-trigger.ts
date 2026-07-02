/**
 * Parse a mission-trigger channel message (companion-missions.md §3.2). The scheduler's
 * `discord-notify` action posts `<@companionBot> <event text>` into the mission channel;
 * the companion bot receives it (it is @-mentioned), strips the leading mention token(s),
 * and treats the remainder as the event. Plain text, not JSON — v1 carries the event only,
 * and routing is by the single active mission.
 *
 * This is pure string handling (trust — the allowlisted sender + channel — is enforced by
 * the router, not here), so it is unit-tested in isolation.
 */

/**
 * Leading Discord user-mention tokens: `<@123>` or `<@!123>` (the `!` nickname form),
 * one or more, with surrounding whitespace. Anchored to the START only — a `<@…>` that
 * appears later in the event text is left untouched (it is part of what the predicate said).
 */
const LEADING_USER_MENTIONS = /^(?:<@!?\d+>\s*)+/;

/**
 * Strip the leading bot-mention from a trigger message and return the event text, or
 * `null` when nothing meaningful remains (an empty or mention-only message — logged and
 * dropped by the router rather than advancing a mission on nothing).
 */
export function parseTriggerEvent(content: string): string | null {
  const event = content.replace(LEADING_USER_MENTIONS, '').trim();
  return event.length > 0 ? event : null;
}
