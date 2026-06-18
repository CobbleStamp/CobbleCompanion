/**
 * WS transport (Phase D D1): handshake auth + request/response correlation over the
 * single socket. Runs against a real listener with Node's global WebSocket client,
 * so it exercises the real upgrade (and the browser-style ?access_token= bearer).
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

interface Envelope {
  id?: string;
  result?: unknown;
  error?: { message: string; code?: string };
}

describe('ws transport', () => {
  let ctx: TestApp;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${addr.port}/ws`;
  });

  afterEach(async () => {
    await ctx.close();
  });

  /** The raw bearer the FakeTokenVerifier registered for an address. */
  function tokenFor(address: string): string {
    return ctx.bearerFor(address).authorization.slice('Bearer '.length);
  }

  function connect(token?: string): WebSocket {
    const query = token ? `?access_token=${encodeURIComponent(token)}` : '';
    return new WebSocket(`${baseUrl}${query}`);
  }

  /** Open, send one request, resolve its reply envelope, then close. */
  async function call(token: string, request: unknown): Promise<Envelope> {
    const client = connect(token);
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve(), { once: true });
      client.addEventListener('error', () => reject(new Error('connection failed')), {
        once: true,
      });
    });
    const reply = new Promise<Envelope>((resolve) => {
      client.addEventListener(
        'message',
        (event: MessageEvent) => resolve(JSON.parse(String(event.data)) as Envelope),
        { once: true },
      );
    });
    client.send(JSON.stringify(request));
    const envelope = await reply;
    client.close();
    return envelope;
  }

  it('authenticates at the handshake and answers ping correlated by id', async () => {
    const reply = await call(tokenFor('owner@example.com'), {
      id: 'r1',
      method: 'ping',
      params: { hi: true },
    });
    expect(reply).toEqual({ id: 'r1', result: { pong: true, echo: { hi: true } } });
  });

  it('returns the handshake-derived identity from auth.me', async () => {
    const reply = await call(tokenFor('owner@example.com'), { id: 'm1', method: 'auth.me' });
    expect(reply.id).toBe('m1');
    expect((reply.result as { user: { id: string } }).user.id).toEqual(expect.any(String));
  });

  it('replies with an error envelope for an unknown method', async () => {
    const reply = await call(tokenFor('owner@example.com'), { id: 'x', method: 'does.not.exist' });
    expect(reply.id).toBe('x');
    expect(reply.error?.code).toBe('unknown_method');
  });

  it('replies with a bad_request error for a malformed envelope', async () => {
    const reply = await call(tokenFor('owner@example.com'), { method: 'ping' }); // no id
    expect(reply.error?.code).toBe('bad_request');
  });

  it('rejects an unauthenticated upgrade (no token)', async () => {
    const client = connect();
    const outcome = await new Promise<string>((resolve) => {
      client.addEventListener('open', () => resolve('open'), { once: true });
      client.addEventListener('error', () => resolve('error'), { once: true });
      client.addEventListener('close', () => resolve('close'), { once: true });
    });
    expect(outcome).not.toBe('open');
    try {
      client.close();
    } catch {
      // already closed
    }
  });
});
