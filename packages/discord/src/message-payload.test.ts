/**
 * buildDmPayload: a body within Discord's limit sends inline (content only, no files);
 * an over-limit body sends a short lead-in with the full text attached verbatim as a
 * `.md` file; the boundary (exactly at the limit) stays inline.
 */

import { describe, expect, it } from 'vitest';
import { DISCORD_MESSAGE_LIMIT } from './command-render.js';
import { buildDmPayload, OVERFLOW_FILE_NAME, OVERFLOW_LEAD_IN } from './message-payload.js';

describe('buildDmPayload', () => {
  it('sends a short body inline with no attachment', () => {
    const payload = buildDmPayload('good morning');
    expect(payload).toEqual({ content: 'good morning' });
    expect(payload.files).toBeUndefined();
  });

  it('keeps a body exactly at the limit inline (the limit length is allowed)', () => {
    const atLimit = 'x'.repeat(DISCORD_MESSAGE_LIMIT);
    const payload = buildDmPayload(atLimit);
    expect(payload.content).toBe(atLimit);
    expect(payload.files).toBeUndefined();
  });

  it('attaches the full text as a .md file when the body exceeds the limit', () => {
    const report = 'y'.repeat(DISCORD_MESSAGE_LIMIT + 1);
    const payload = buildDmPayload(report);

    expect(payload.content).toBe(OVERFLOW_LEAD_IN);
    expect(payload.files).toHaveLength(1);
    const file = payload.files?.[0];
    expect(file?.name).toBe(OVERFLOW_FILE_NAME);
    // The attachment carries the WHOLE body verbatim — nothing is truncated.
    expect(file?.attachment.toString('utf8')).toBe(report);
  });

  it('preserves multi-byte content in the attachment (UTF-8 round-trip)', () => {
    const report = `${'📈 '.repeat(DISCORD_MESSAGE_LIMIT)}`;
    const payload = buildDmPayload(report);
    expect(payload.files?.[0]?.attachment.toString('utf8')).toBe(report);
  });
});
