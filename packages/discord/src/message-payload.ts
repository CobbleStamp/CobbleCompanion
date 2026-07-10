/**
 * Turn a DM's text into the payload the gateway sends (companion-discord.md §5).
 * Discord rejects a single message longer than {@link DISCORD_MESSAGE_LIMIT}
 * characters, and a long turn — a mission's pre-market report, a detailed chat
 * answer — routinely exceeds it. Rather than truncate (losing the tail) or split
 * into fragile multi-message chunks (which can break mid-code-block or interleave
 * with the typing cue), the whole text rides as a UTF-8 `.md` attachment behind a
 * short lead-in. Short messages are unchanged: they send inline as before.
 *
 * The returned shape is exactly what `discord.js` `channel.send` accepts, so the
 * gateway passes it straight through. Kept pure (no clock, no I/O, no `discord.js`)
 * so it's covered by unit tests; the real send lives in `discord-js-gateway.ts`.
 *
 * Depends only on the limit constant — nothing from `@cobble/core`.
 */

import { DISCORD_MESSAGE_LIMIT } from './command-render.js';

/** The lead-in shown in place of an over-limit body; the full text is attached. */
export const OVERFLOW_LEAD_IN =
  '📄 This ran long for a single Discord message — the full text is attached.';

/** Filename for the overflow attachment (`.md` so clients render a formatted preview). */
export const OVERFLOW_FILE_NAME = 'message.md';

/** One file to attach to a DM (the shape `discord.js` accepts as an `AttachmentPayload`). */
export interface DmAttachment {
  readonly attachment: Buffer;
  readonly name: string;
}

/** A DM payload: inline `content`, plus optional `files` when the body overflowed. */
export interface DmPayload {
  readonly content: string;
  readonly files?: readonly DmAttachment[];
}

/**
 * Build the DM payload for `content`: sent inline when it fits Discord's per-message
 * limit, otherwise a short lead-in with the full text attached as a `.md` file.
 */
export function buildDmPayload(content: string): DmPayload {
  if (content.length <= DISCORD_MESSAGE_LIMIT) {
    return { content };
  }
  return {
    content: OVERFLOW_LEAD_IN,
    files: [{ attachment: Buffer.from(content, 'utf8'), name: OVERFLOW_FILE_NAME }],
  };
}
