/**
 * WS live delivery (Phase D D4): an event appended to companion_events (on any node)
 * is pushed to the live embodiment connection by its heartbeat — the cross-node
 * delivery that replaces the in-process SSE bus (Problem 5).
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanionStreamEvent } from '@cobble/shared';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('ws live delivery', () => {
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

  it('fails the connection closed when the live-cursor init query errors (no history replay)', async () => {
    // A transient DB error on latestSettledSeq must NOT fall back to cursor 0 — that
    // would make the first heartbeat re-deliver the entire settled history as live
    // events. Closing lets the client reconnect and re-init the cursor cleanly.
    const log = ctx.deps.eventLog as { latestSettledSeq: (id: string) => Promise<number> };
    log.latestSettledSeq = () => Promise.reject(new Error('db unavailable'));

    const client = new WebSocket(
      `ws://${host}/ws?companion=${companionId}&access_token=${encodeURIComponent(token)}`,
    );
    const closed = new Promise<{ code: number }>((resolve, reject) => {
      client.addEventListener('close', (e: CloseEvent) => resolve({ code: e.code }), {
        once: true,
      });
      // A replayed history would arrive as a 'companion' frame before any close.
      client.addEventListener(
        'message',
        (e: MessageEvent) => {
          const frame = JSON.parse(String(e.data)) as { event?: string };
          if (frame.event === 'companion') {
            reject(new Error('history was replayed instead of failing closed'));
          }
        },
        { once: true },
      );
    });

    const outcome = await closed;
    expect(outcome.code).toBe(1011);
    try {
      client.close();
    } catch {
      // already closed
    }
  });

  it('pushes a companion_events row to the embodied connection via the heartbeat', async () => {
    const client = new WebSocket(
      `ws://${host}/ws?companion=${companionId}&access_token=${encodeURIComponent(token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve(), { once: true });
      client.addEventListener('error', () => reject(new Error('connection failed')), {
        once: true,
      });
    });
    try {
      const event: CompanionStreamEvent = {
        type: 'reaction_added',
        messageId: 'm1',
        reactor: 'companion',
        emoji: '✨',
      };
      // Wait for the delivery frame, then append (the heartbeat polls every ~40ms).
      const delivered = new Promise<{ event: string; data: CompanionStreamEvent }>((resolve) => {
        client.addEventListener('message', (e: MessageEvent) => {
          const frame = JSON.parse(String(e.data)) as {
            event?: string;
            data?: CompanionStreamEvent;
          };
          if (frame.event === 'companion') {
            resolve({ event: frame.event, data: frame.data as CompanionStreamEvent });
          }
        });
      });
      // Append on the server side — simulating an event written by any node/path.
      await ctx.deps.eventLog.append(companionId, event);
      const received = await delivered;
      expect(received.data).toEqual(event);
    } finally {
      client.close();
    }
  });
});
