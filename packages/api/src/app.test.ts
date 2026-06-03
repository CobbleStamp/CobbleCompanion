import type { Logger } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './test/helpers.js';

interface LogEntry {
  readonly message: string;
  readonly context: Record<string, unknown>;
}

/** Capturing logger so tests can assert errors are logged with full context. */
function capturingLogger(error: LogEntry[], info: LogEntry[]): Logger {
  return {
    error: (message, context) => error.push({ message, context }),
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
    // A non-UUID companion id makes the DB driver throw (invalid uuid syntax),
    // surfacing as an unhandled 500 through the route handler.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/companions/not-a-uuid/messages',
      headers: ctx.bearerFor('owner@example.com'),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal server error' });

    expect(errors).toHaveLength(1);
    const entry = errors[0]!;
    expect(entry.message).toBe('request failed');
    expect(entry.context).toMatchObject({
      operation: 'http.request',
      method: 'GET',
      url: '/companions/not-a-uuid/messages',
      statusCode: 500,
    });
    // The error itself is logged (message + stack), not just a string.
    expect(entry.context.error).toBeInstanceOf(Error);
  });

  it('logs a 4xx client error at info severity, not error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions/00000000-0000-0000-0000-000000000000/messages',
      headers: { ...ctx.bearerFor('owner@example.com'), 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    expect(res.statusCode).toBe(400);
    expect(errors).toHaveLength(0);
    expect(infos.some((e) => e.message === 'request rejected' && e.context.statusCode === 400)).toBe(
      true,
    );
  });
});
