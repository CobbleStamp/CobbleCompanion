/**
 * WS methods (Phase D D3): the migrated routes as WS methods over an embodied
 * connection — a read, a write, the streaming turn, and fencing. The HTTP route
 * tests still cover the per-route business logic; this proves the WS method layer.
 */

import type { AddressInfo } from 'node:net';
import { decryptSecret, keyFromBase64 } from '@cobble/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, testConfig, type TestApp } from '../test/helpers.js';

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

  it('records tab visibility via presence.heartbeat (D5) without nudging motivation', async () => {
    const nudged: string[] = [];
    ctx.deps.motivation.request = (id: string): void => {
      nudged.push(id);
    };
    const client = await open(true);
    try {
      const { frame } = await call(client, {
        id: '6',
        method: 'presence.heartbeat',
        params: { tabVisible: false },
      });
      expect(frame.result).toEqual({ ok: true });
      // The heartbeat recorded the reported (background) visibility on the presence signal.
      expect((await ctx.deps.presence.get(companionId))?.tabVisible).toBe(false);
      // A heartbeat is deliberately not a motivation trigger (presence-route parity).
      expect(nudged).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it('identifies the user over a transport-only connection (auth.me)', async () => {
    const client = await open(false);
    try {
      const { frame } = await call(client, { id: '7', method: 'auth.me' });
      const { user } = frame.result as { user: { id: string; email: string | null } };
      expect(typeof user.id).toBe('string');
      expect(user.email).toBe('owner@example.com');
    } finally {
      client.close();
    }
  });

  describe('discord.config.* (user-scoped, T13)', () => {
    interface View {
      configured: boolean;
      boundCompanionId: string | null;
      ownerLinked: boolean;
      linkCode: string | null;
    }

    it('saves the bot token encrypted, then reads it back without the token', async () => {
      const client = await open(false);
      try {
        const before = await call(client, { id: 'd1', method: 'discord.config.get' });
        expect((before.frame.result as { discord: View }).discord.configured).toBe(false);

        const saved = await call(client, {
          id: 'd2',
          method: 'discord.config.set',
          params: { botToken: 'super-secret-bot-token', boundCompanionId: companionId },
        });
        const view = (saved.frame.result as { discord: View }).discord;
        expect(view).toMatchObject({
          configured: true,
          boundCompanionId: companionId,
          ownerLinked: false,
        });
        expect(view.linkCode).toMatch(/^[A-Z0-9]{8}$/);

        // The stored token is encrypted at rest, and decrypts back to the plaintext.
        const userId = (await ctx.deps.identity.ensureUserByEmail('owner@example.com')).id;
        const record = await ctx.deps.discordConfig.findByUserId(userId);
        expect(record?.encryptedBotToken).not.toContain('super-secret-bot-token');
        const key = keyFromBase64(testConfig.discordTokenKey);
        expect(decryptSecret(record!.encryptedBotToken, key)).toEqual({
          ok: true,
          plaintext: 'super-secret-bot-token',
        });
      } finally {
        client.close();
      }
    });

    it('rejects binding a companion the caller does not own (not_found)', async () => {
      const client = await open(false);
      try {
        const { frame } = await call(client, {
          id: 'd3',
          method: 'discord.config.set',
          params: { botToken: 't', boundCompanionId: '00000000-0000-0000-0000-000000000000' },
        });
        expect(frame.error?.code).toBe('not_found');
      } finally {
        client.close();
      }
    });

    it('regenerates the link code without changing the binding', async () => {
      const client = await open(false);
      try {
        const first = await call(client, {
          id: 'd4',
          method: 'discord.config.set',
          params: { botToken: 't', boundCompanionId: companionId },
        });
        const firstCode = (first.frame.result as { discord: View }).discord.linkCode;
        const regen = await call(client, { id: 'd5', method: 'discord.config.regenerateLink' });
        const view = (regen.frame.result as { discord: View }).discord;
        expect(view.boundCompanionId).toBe(companionId);
        expect(view.linkCode).toMatch(/^[A-Z0-9]{8}$/);
        expect(view.linkCode).not.toBe(firstCode);
      } finally {
        client.close();
      }
    });

    it('deletes the config (back to unconfigured)', async () => {
      const client = await open(false);
      try {
        await call(client, {
          id: 'd6',
          method: 'discord.config.set',
          params: { botToken: 't', boundCompanionId: companionId },
        });
        const del = await call(client, { id: 'd7', method: 'discord.config.delete' });
        expect(del.frame.result).toEqual({ ok: true });
        const after = await call(client, { id: 'd8', method: 'discord.config.get' });
        expect((after.frame.result as { discord: View }).discord.configured).toBe(false);
      } finally {
        client.close();
      }
    });
  });
});
