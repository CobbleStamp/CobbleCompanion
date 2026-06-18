/**
 * WS embodiment (Phase D D2): connecting claims a companion, a method is fenced on
 * the live claim, and a newer connection takes the room (handoff) so the prior one
 * self-fences and closes. Runs against a real listener with Node's global WebSocket.
 */

import {
  FakeLlmGateway,
  type LlmGateway,
  type LlmStreamParams,
  type StreamResult,
} from '@cobble/core';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

/**
 * Wraps a fake gateway, firing a one-shot hook at the start of the FIRST `stream()`
 * call. A test uses it to mutate state mid-turn — here, to force-claim the companion
 * from a newer owner between the loop's top-of-iteration lease check and the
 * pre-finish re-check, deterministically staging a mid-turn handoff (§5.2) on
 * single-connection PGlite (which can't host two live connections at once).
 */
class MidStreamHookGateway implements LlmGateway {
  onBeforeFirstStream?: (() => Promise<void>) | undefined;
  private readonly inner = new FakeLlmGateway(['Thinking… ', 'here is your answer.']);

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    const hook = this.onBeforeFirstStream;
    this.onBeforeFirstStream = undefined;
    if (hook) {
      await hook();
    }
    return yield* this.inner.stream(params);
  }
}

/** Lexically-maximal ULID — guaranteed to win the "newer owner" force-claim. */
const NEWER_OWNER = 'Z'.repeat(26);

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

describe('ws mid-turn embodiment fence (§5.2)', () => {
  let ctx: TestApp;
  let host: string;
  let token: string;
  let companionId: string;
  let gateway: MidStreamHookGateway;

  beforeEach(async () => {
    gateway = new MidStreamHookGateway();
    ctx = await makeTestApp(undefined, undefined, {
      llmGateway: gateway,
      // Park the heartbeat so the ONLY path that can supersede the connection during
      // the test is the mid-turn loop fence — not a heartbeat that noticed the claim.
      config: { wsHeartbeatMs: 60_000 },
    });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address() as AddressInfo;
    host = `127.0.0.1:${addr.port}`;
    token = ctx.bearerFor('owner@example.com').authorization.slice('Bearer '.length);
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

  it('stands the turn down when the room is claimed mid-loop, without writing a reply', async () => {
    const client = await open(`companion=${companionId}&access_token=${encodeURIComponent(token)}`);

    // Once the turn enters its first LLM call, a newer owner force-claims the room
    // (the user "moved" to another device). The loop's pre-finish lease re-check then
    // sees the claim has moved and stands down.
    gateway.onBeforeFirstStream = async () => {
      await ctx.deps.embodiment.claim({
        companionId,
        owner: NEWER_OWNER,
        node: 'other-node',
        ttlMs: ctx.deps.config.wsClaimTtlMs,
      });
    };

    const outcome = new Promise<string>((resolve) => {
      client.addEventListener('message', (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as Envelope;
        if (msg.event === 'embodiment.superseded') {
          resolve('superseded');
        }
      });
      client.addEventListener('close', () => resolve('close'), { once: true });
    });

    try {
      client.send(JSON.stringify({ id: 't', method: 'messages.send', params: { content: 'hi' } }));
      // The connection is told it lost the room (and closes) — from the turn fence,
      // not a heartbeat (parked at 60s).
      expect(['superseded', 'close']).toContain(await outcome);

      // The reply was NOT persisted: only the user message landed (the turn stood
      // down before the assistant append). The companion now lives on the new claim.
      const recent = await ctx.deps.memory.getRecentMessages(companionId, 10);
      const assistantReplies = recent.filter(
        (m) => m.role === 'assistant' && (m.kind ?? 'message') === 'message',
      );
      expect(assistantReplies).toHaveLength(0);
      expect(recent.some((m) => m.role === 'user' && m.content === 'hi')).toBe(true);
    } finally {
      client.close();
    }
  });
});
