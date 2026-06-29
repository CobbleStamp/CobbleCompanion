/**
 * WS handshake origin pin (security/hardening): @fastify/cors does not run on the
 * upgrade, so `makeWsAuth` itself rejects a cross-origin upgrade. A browser always
 * sends `Origin` on a WS upgrade — only the configured app origin is accepted; a
 * non-browser service client sends no `Origin` (and authenticates with a bearer),
 * so absence is allowed.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintSurfaceAccessToken } from '../auth/session-tokens.js';
import { makeTestApp, type TestApp } from '../test/helpers.js';
import { makeWsAuth } from './handshake.js';

interface FakeReply {
  statusCode?: number;
  body?: unknown;
}

/** A minimal FastifyReply that records the first code()/send() pair. */
function fakeReply(): { reply: FastifyReply; sent: FakeReply } {
  const sent: FakeReply = {};
  const reply = {
    code(status: number): FastifyReply {
      sent.statusCode = status;
      return reply;
    },
    async send(body: unknown): Promise<void> {
      sent.body = body;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

function fakeRequest(headers: Record<string, string>): FastifyRequest {
  return { headers, query: {} } as unknown as FastifyRequest;
}

describe('ws handshake origin pin', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('rejects an upgrade whose Origin is not the configured app origin', async () => {
    const wsAuth = makeWsAuth(ctx.deps);
    const { authorization } = ctx.bearerFor('user@example.com');
    const request = fakeRequest({ origin: 'https://evil.example', authorization });
    const { reply, sent } = fakeReply();

    await wsAuth(request, reply);

    expect(sent.statusCode).toBe(403);
    expect(request.userId).toBeUndefined(); // never authenticated — fenced before verify
  });

  it('accepts an upgrade whose Origin matches the configured app origin', async () => {
    const wsAuth = makeWsAuth(ctx.deps);
    const { authorization } = ctx.bearerFor('user@example.com');
    const request = fakeRequest({ origin: ctx.deps.config.appUrl, authorization });
    const { reply, sent } = fakeReply();

    await wsAuth(request, reply);

    expect(sent.statusCode).toBeUndefined(); // no rejection
    expect(request.userId).toBeTruthy();
  });

  it('accepts a discord-surface token at /ws (rejected only by the HTTP guard)', async () => {
    // The Discord bridge embodies over /ws with a surface-scoped token. The WS handshake
    // must accept it — the surface scope only fences it OUT of the HTTP API, not /ws.
    const wsAuth = makeWsAuth(ctx.deps);
    const token = mintSurfaceAccessToken(
      { authSource: 'google', email: 'discord-user@example.com' },
      'discord',
      ctx.deps.config.jwtSigningSecret,
      ctx.deps.config.accessTokenTtlSec,
    );
    const request = fakeRequest({
      origin: ctx.deps.config.appUrl,
      authorization: `Bearer ${token}`,
    });
    const { reply, sent } = fakeReply();

    await wsAuth(request, reply);

    expect(sent.statusCode).toBeUndefined(); // accepted
    expect(request.userId).toBeTruthy();
  });

  it('accepts an upgrade with no Origin header (non-browser service client)', async () => {
    const wsAuth = makeWsAuth(ctx.deps);
    const { authorization } = ctx.bearerFor('service@example.com');
    const request = fakeRequest({ authorization });
    const { reply, sent } = fakeReply();

    await wsAuth(request, reply);

    expect(sent.statusCode).toBeUndefined();
    expect(request.userId).toBeTruthy();
  });
});
