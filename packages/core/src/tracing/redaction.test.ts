/** Redaction modes: strict/metadata_only drop content; off scrubs PII. */

import { describe, expect, it } from 'vitest';
import { scrubContent, scrubError } from './redaction.js';

describe('scrubContent', () => {
  const content = { messages: 'email me at a@b.com or call 555-123-4567', valence: 1 };

  it('drops all content under strict', () => {
    expect(scrubContent(content, 'strict')).toBeUndefined();
  });

  it('drops all content under metadata_only', () => {
    expect(scrubContent(content, 'metadata_only')).toBeUndefined();
  });

  it('passes content under off but scrubs PII-shaped substrings', () => {
    const scrubbed = scrubContent(content, 'off') as Record<string, unknown>;
    expect(scrubbed.messages).not.toContain('a@b.com');
    expect(scrubbed.messages).toContain('[redacted]');
    expect(scrubbed.valence).toBe(1);
  });

  it('scrubs secret-shaped substrings (JWT, Bearer token, api key) under off', () => {
    const secrets = {
      a: 'token eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSMeKKF2',
      b: 'Authorization: Bearer sk-live-abcdef123456',
      c: 'key sk-proj-ABCD1234efgh',
    };
    const scrubbed = scrubContent(secrets, 'off') as Record<string, string>;
    expect(scrubbed.a).not.toContain('eyJhbGciOiJ');
    expect(scrubbed.b).not.toContain('sk-live-abcdef123456');
    expect(scrubbed.c).not.toContain('sk-proj-ABCD1234efgh');
    expect(scrubbed.a).toContain('[redacted]');
  });

  it('recurses into nested arrays and objects', () => {
    const nested = scrubContent({ turns: [{ text: 'reach me: x@y.io' }] }, 'off') as {
      turns: { text: string }[];
    };
    expect(nested.turns[0]!.text).toBe('reach me: [redacted]');
  });

  it('returns undefined when there is no content', () => {
    expect(scrubContent(undefined, 'off')).toBeUndefined();
  });
});

describe('scrubError', () => {
  // A provider error that echoes the prompt — content that must not leak.
  const error = 'HTTP 400: prompt "email me at a@b.com" was rejected';

  it('drops the message under strict', () => {
    expect(scrubError(error, 'strict')).toBeUndefined();
  });

  it('drops the message under metadata_only', () => {
    expect(scrubError(error, 'metadata_only')).toBeUndefined();
  });

  it('passes the message under off but scrubs PII-shaped substrings', () => {
    const scrubbed = scrubError(error, 'off');
    expect(scrubbed).not.toContain('a@b.com');
    expect(scrubbed).toContain('[redacted]');
  });

  it('returns undefined when there is no error', () => {
    expect(scrubError(undefined, 'strict')).toBeUndefined();
    expect(scrubError(undefined, 'off')).toBeUndefined();
  });

  it('caps an oversized error string so it cannot bloat a batch', () => {
    const huge = 'x'.repeat(5000);
    const scrubbed = scrubError(huge, 'off') ?? '';
    expect(scrubbed.length).toBeLessThanOrEqual(501); // 500 chars + the ellipsis
    expect(scrubbed.endsWith('…')).toBe(true);
  });
});
