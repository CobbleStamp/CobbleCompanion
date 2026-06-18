import type { Logger } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactUrl } from './app.js';
import { makeTestApp, type TestApp } from './test/helpers.js';

interface LogEntry {
  readonly message: string;
  readonly context: Record<string, unknown>;
}

/** Capturing logger so tests can assert errors are logged with full context. */
function capturingLogger(error: LogEntry[], info: LogEntry[]): Logger {
  return {
    error: (message, context) => error.push({ message, context }),
    warn: (message, context) => info.push({ message, context: context ?? {} }),
    info: (message, context) => info.push({ message, context: context ?? {} }),
  };
}

describe('app error logging (common/logging.md)', () => {
  let errors: LogEntry[];
  let infos: LogEntry[];
  let ctx: TestApp;

  beforeEach(async () => {
    errors = [];
    infos = [];
    ctx = await makeTestApp(['Hi'], capturingLogger(errors, infos));
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('logs an unexpected 5xx with full context and never leaks internals', async () => {
    // Inject a genuine internal failure (a store throw) to exercise the 5xx path,
    // via the one remaining HTTP route (the file upload, which calls getCompanion
    // first). A valid-format id is needed so the param guard lets it through to the
    // handler — a malformed id is now a clean 404 (see the next test).
    const url = '/companions/00000000-0000-0000-0000-000000000000/sources/file';
    ctx.deps.identity.getCompanion = async () => {
      throw new Error('boom');
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url,
      headers: ctx.bearerFor('owner@example.com'),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal server error' });

    expect(errors).toHaveLength(1);
    const entry = errors[0]!;
    expect(entry.message).toBe('request failed');
    expect(entry.context).toMatchObject({
      operation: 'http.request',
      method: 'POST',
      url,
      statusCode: 500,
    });
    // The error itself is logged (message + stack), not just a string.
    expect(entry.context.error).toBeInstanceOf(Error);
  });

  it('redacts a credential query param from the 5xx error log', async () => {
    // A WS handshake failure routes through this same error handler, and the
    // browser bearer rides the URL as ?access_token=<jwt>. The log must carry the
    // redacted URL, never the live token (regression guard for app.ts:243).
    ctx.deps.identity.getCompanion = async () => {
      throw new Error('boom');
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions/00000000-0000-0000-0000-000000000000/sources/file?access_token=live.jwt',
      headers: ctx.bearerFor('owner@example.com'),
    });

    expect(res.statusCode).toBe(500);
    expect(errors).toHaveLength(1);
    const loggedUrl = errors[0]!.context.url;
    expect(loggedUrl).not.toContain('live.jwt');
    expect(loggedUrl).toContain('access_token=REDACTED');
  });

  it('rejects a malformed resource id with a clean 404, not a 500', async () => {
    // A non-UUID id can't name a real row; the param guard short-circuits it to
    // 404 before any DB query (which would otherwise throw Postgres 22P02 → 500).
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions/not-a-uuid/sources/file',
      headers: ctx.bearerFor('owner@example.com'),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'companion not found' });
    // A validation 404 is a client error, not an internal failure — nothing logged.
    expect(errors).toHaveLength(0);
  });

  it('logs a 4xx client error at info severity, not error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions/00000000-0000-0000-0000-000000000000/sources/file',
      headers: { ...ctx.bearerFor('owner@example.com'), 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    expect(res.statusCode).toBe(400);
    expect(errors).toHaveLength(0);
    expect(
      infos.some((e) => e.message === 'request rejected' && e.context.statusCode === 400),
    ).toBe(true);
  });
});

describe('redactUrl (S1 — access-log token redaction)', () => {
  it('redacts the access_token a browser WebSocket sends in the handshake URL', () => {
    // ws/handshake.ts accepts the bearer as ?access_token=<jwt>; the access log
    // must never carry a live, replayable token.
    expect(redactUrl('/ws?access_token=eyJhbG.live.jwt&companion=c_123')).toBe(
      '/ws?access_token=REDACTED&companion=c_123',
    );
  });

  it('redacts a bare token param', () => {
    expect(redactUrl('/ws?token=secret')).toBe('/ws?token=REDACTED');
  });

  it('leaves a URL with no query string untouched', () => {
    expect(redactUrl('/companions/c_123/messages')).toBe('/companions/c_123/messages');
  });

  it('preserves non-sensitive query params verbatim', () => {
    expect(redactUrl('/ws?companion=c_123')).toBe('/ws?companion=c_123');
  });

  it('redacts every credential param when several are present', () => {
    expect(redactUrl('/ws?access_token=a&token=b&companion=c_123')).toBe(
      '/ws?access_token=REDACTED&token=REDACTED&companion=c_123',
    );
  });
});
