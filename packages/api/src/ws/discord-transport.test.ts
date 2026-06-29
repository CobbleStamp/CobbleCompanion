/**
 * The live wire-contract test the Discord adapter's fakes can't prove (T14): the real
 * `WsTransport` from `@cobble/discord` against a real `/ws` (a running Fastify app +
 * the real embodiment lease). It self-mints a user access token (via `bearerFor`),
 * claims embodiment, runs a chat turn, and observes a real `embodiment.superseded`
 * takeover when a second connection claims the same companion.
 *
 * Lives in `@cobble/api` (which owns `makeTestApp` + the `/ws` server); `@cobble/discord`
 * is a dev-only dependency here. It does not invert the surface→core boundary —
 * `@cobble/discord` still imports nothing from the API.
 */

import type { AddressInfo } from 'node:net';
import { WsTransport } from '@cobble/discord';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, silentLogger, type TestApp } from '../test/helpers.js';

describe('discord WsTransport against a real /ws', () => {
  let ctx: TestApp;
  let host: string;
  let token: string;
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    host = `127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
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

  const wsUrl = (): string =>
    `ws://${host}/ws?companion=${companionId}&access_token=${encodeURIComponent(token)}`;

  it('claims embodiment, runs a chat turn, and is superseded by a second claim', async () => {
    const first = new WsTransport({ logger: silentLogger });
    await first.connect({ url: wsUrl(), headers: {}, embodying: true });

    // The connection holds the live claim for the bound companion.
    const who = await first.call<{ companionId: string }>('embodiment.whoami');
    expect(who.companionId).toBe(companionId);

    // A real streamed turn terminates with a `done`.
    const events: { type: string }[] = [];
    for await (const chunk of first.callStream('messages.send', { content: 'hello' })) {
      events.push(chunk as { type: string });
    }
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // A second connection claims the same companion → the first is superseded.
    let superseded = false;
    first.onEvent((name) => {
      if (name === 'embodiment.superseded') superseded = true;
    });
    const second = new WsTransport({ logger: silentLogger });
    await second.connect({ url: wsUrl(), headers: {}, embodying: true });

    // The first connection receives the real takeover notice (newer wins).
    await waitUntil(() => superseded);
    expect(first.isSuperseded).toBe(true);

    // The second connection is now the holder.
    const who2 = await second.call<{ companionId: string }>('embodiment.whoami');
    expect(who2.companionId).toBe(companionId);

    first.close();
    second.close();
  });

  it('rejects a chat turn on a transport-only connection (no companion claimed)', async () => {
    const transport = new WsTransport({ logger: silentLogger });
    await transport.connect({
      url: `ws://${host}/ws?access_token=${encodeURIComponent(token)}`,
      headers: {},
      embodying: false,
    });
    // messages.send is companion-scoped; without a claim it's refused not_embodied.
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of transport.callStream('messages.send', { content: 'hi' })) {
          events.push(chunk);
        }
      })(),
    ).rejects.toThrow();
    transport.close();
  });
});

/** Poll a predicate up to ~2s (the supersede notice is delivered asynchronously). */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met within timeout');
}
