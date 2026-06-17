/**
 * WS embodiment (Phase D D2): connecting claims a companion, a method is fenced on
 * the live claim, and a newer connection takes the room (handoff) so the prior one
 * self-fences and closes. Runs against a real listener with Node's global WebSocket.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

interface Envelope {
  id?: string;
  result?: unknown;
  error?: { message: string; code?: string };
  event?: string;
  data?: unknown;
}

describe('ws embodiment', () => {
  let ctx: TestApp;
  let host: string;
  let token: string;
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address() as AddressInfo;
    host = `127.0.0.1:${addr.port}`;
    const auth = ctx.bearerFor('owner@example.com');
    token = auth.authorization.slice('Bearer '.length);
    const user = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    companionId = (
      await ctx.deps.identity.createCompanion(user.id, {
        name: 'Pebble',
        form: 'fox',
        temperament: 'curious',
      })
    ).id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  function open(query: string): Promise<WebSocket> {
    const client = new WebSocket(`ws://${host}/ws?${query}`);
    return new Promise((resolve, reject) => {
      client.addEventListener('open', () => resolve(client), { once: true });
      client.addEventListener('error', () => reject(new Error('connection failed')), {
        once: true,
      });
    });
  }

  function nextMessage(client: WebSocket): Promise<Envelope> {
    return new Promise((resolve) => {
      client.addEventListener(
        'message',
        (event: MessageEvent) => resolve(JSON.parse(String(event.data)) as Envelope),
        { once: true },
      );
    });
  }

  async function callOn(client: WebSocket, request: unknown): Promise<Envelope> {
    const reply = nextMessage(client);
    client.send(JSON.stringify(request));
    return reply;
  }

  it('embodies the named companion at the handshake', async () => {
    const client = await open(`companion=${companionId}&access_token=${encodeURIComponent(token)}`);
    try {
      const reply = await callOn(client, { id: 'w', method: 'embodiment.whoami' });
      expect(reply).toMatchObject({ id: 'w', result: { companionId } });
    } finally {
      client.close();
    }
  });

  it('fences a fenced method on a transport-only connection (no companion)', async () => {
    const client = await open(`access_token=${encodeURIComponent(token)}`);
    try {
      const reply = await callOn(client, { id: 'w', method: 'embodiment.whoami' });
      expect(reply.error?.code).toBe('not_embodied');
    } finally {
      client.close();
    }
  });

  it('hands off to a newer connection — the prior one is superseded and closes', async () => {
    const first = await open(`companion=${companionId}&access_token=${encodeURIComponent(token)}`);
    // The first connection owns the room.
    expect((await callOn(first, { id: 'a', method: 'embodiment.whoami' })).result).toMatchObject({
      companionId,
    });

    // Watch for the first connection's supersession (event) and close.
    const superseded = new Promise<string>((resolve) => {
      first.addEventListener('message', (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as Envelope;
        if (msg.event === 'embodiment.superseded') {
          resolve('event');
        }
      });
      first.addEventListener('close', () => resolve('close'), { once: true });
    });

    // A newer connection claims the same companion (the user "moves rooms").
    const second = await open(`companion=${companionId}&access_token=${encodeURIComponent(token)}`);
    try {
      expect((await callOn(second, { id: 'b', method: 'embodiment.whoami' })).result).toMatchObject(
        {
          companionId,
        },
      );
      // The first connection self-fences on its next heartbeat.
      expect(['event', 'close']).toContain(await superseded);
    } finally {
      first.close();
      second.close();
    }
  });
});
