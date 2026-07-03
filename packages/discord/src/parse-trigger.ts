/**
 * Parse a mission-trigger channel message (companion-missions.md §3.2). The scheduler's
 * `discord-notify` action posts `<@companionBot> mission:<missionId> <event text>` into the
 * mission channel; the companion bot receives it (it is @-mentioned), strips the leading
 * mention token(s), reads the mission id the wake was armed with, and treats the remainder
 * as the event. Every wake MUST name its mission — that id is how the companion knows what
 * the notification is for; a message without a valid one is not a mission wake and is
 * dropped by the router (logged), never advanced on a guess.
 *
 * This is pure string handling (trust — the allowlisted sender + channel — is enforced by
 * the router, not here), so it is unit-tested in isolation.
 */

/** A parsed mission wake: which mission it is for, and the event text that fired it. */
export interface TriggerEvent {
  readonly missionId: string;
  readonly event: string;
}

/**
 * Leading Discord user-mention tokens: `<@123>` or `<@!123>` (the `!` nickname form),
 * one or more, with surrounding whitespace. Anchored to the START only — a `<@…>` that
 * appears later in the event text is left untouched (it is part of what the predicate said).
 */
const LEADING_USER_MENTIONS = /^(?:<@!?\d+>\s*)+/;

/**
 * The mission tag stamped into the wake action at arm time (`start_mission`), followed by
 * the event text. The id is a UUID (the `missions` row id); anything else is not ours.
 */
const MISSION_TAG =
  /^mission:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S[\s\S]*)$/iu;

/**
 * Parse a trigger message into the mission id + event text, or `null` when it is not a
 * well-formed mission wake (no leading mention-stripped `mission:<uuid>` tag, or nothing
 * meaningful after it) — the router logs and drops those rather than advancing a mission
 * the wake never named.
 */
export function parseTriggerEvent(content: string): TriggerEvent | null {
  const stripped = content.replace(LEADING_USER_MENTIONS, '').trim();
  const match = MISSION_TAG.exec(stripped);
  if (!match) return null;
  const event = match[2]!.trim();
  return event.length > 0 ? { missionId: match[1]!.toLowerCase(), event } : null;
}
