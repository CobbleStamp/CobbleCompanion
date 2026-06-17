/**
 * WS methods (Phase D D3): the migrated routes as WS methods over an embodied
 * connection — a read, a write, the streaming turn, and fencing. The HTTP route
 * tests still cover the per-route business logic; this proves the WS method layer.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

interface Frame {
  id?: string;
  result?: unknown;
  error?: { message: string; code?: string };
  stream?: unknown;
}

describe('ws methods', () => {
  let ctx: TestApp;
  let host: string;
  let token: string;
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    host = `127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const auth = ctx.bearerFor('owner@example.com');
    token = auth.authorization.slice('Bearer '.length);
    companionId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/companions',
        headers: auth,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      })
    ).json().companion.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  function open(embodied: boolean): Promise<WebSocket> {
    const query = embodied
      ? `companion=${companionId}&access_token=${encodeURIComponent(token)}`
      : `access_token=${encodeURIComponent(token)}`;
    const client = new WebSocket(`ws://${host}/ws?${query}`);
    return new Promise((resolve, reject) => {
      client.addEventListener('open', () => resolve(client), { once: true });
      client.addEventListener('error', () => reject(new Error('connection failed')), {
        once: true,
      });
    });
  }

  /** Send one request; resolve { result/error, stream[] } once the terminal frame for its id arrives. */
  function call(
    client: WebSocket,
    request: { id: string; method: string; params?: unknown },
  ): Promise<{ frame: Frame; stream: unknown[] }> {
    return new Promise((resolve) => {
      const stream: unknown[] = [];
      const onMessage = (event: MessageEvent): void => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.id !== request.id) return;
        if (frame.stream !== undefined) {
          stream.push(frame.stream);
          return;
        }
        client.removeEventListener('message', onMessage);
        resolve({ frame, stream });
      };
      client.addEventListener('message', onMessage);
      client.send(JSON.stringify(request));
    });
  }

  it('serves a companion-scoped read (messages.list) over the embodied connection', async () => {
    const client = await open(true);
    try {
      const { frame } = await call(client, { id: '1', method: 'messages.list' });
      expect(Array.isArray((frame.result as { messages: unknown[] }).messages)).toBe(true);
    } finally {
      client.close();
    }
  });

  it('serves a write (proactivity.set)', async () => {
    const client = await open(true);
    try {
      const { frame } = await call(client, {
        id: '2',
        method: 'proactivity.set',
        params: { dial: 'gentle' },
      });
      expect(frame.result).toEqual({ dial: 'gentle' });
    } finally {
      client.close();
    }
  });

  it('streams a turn (messages.send) — chunks then a terminal result', async () => {
    const client = await open(true);
    try {
      const { frame, stream } = await call(client, {
        id: '3',
        method: 'messages.send',
        params: { content: 'hello' },
      });
      const events = stream as { type: string }[];
      // The turn emits token chunks then a `done`, and resolves with { done: true }.
      expect(events.some((e) => e.type === 'token')).toBe(true);
      expect(events.some((e) => e.type === 'done')).toBe(true);
      expect(frame.result).toEqual({ done: true });
    } finally {
      client.close();
    }
  });

  it('rejects a companion-scoped method on a transport-only connection (fencing)', async () => {
    const client = await open(false);
    try {
      const { frame } = await call(client, { id: '4', method: 'messages.list' });
      expect(frame.error?.code).toBe('not_embodied');
    } finally {
      client.close();
    }
  });

  it('validates params (bad_params on a malformed write)', async () => {
    const client = await open(true);
    try {
      const { frame } = await call(client, {
        id: '5',
        method: 'proactivity.set',
        params: { dial: 'nonsense' },
      });
      expect(frame.error?.code).toBe('bad_params');
    } finally {
      client.close();
    }
  });
});
