import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('message routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(['Hi', ' there']);
    auth = ctx.bearerFor('owner@example.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    companionId = created.json().companion.id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('returns an empty transcript for a fresh companion', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([]);
  });

  it('404s reading messages of a companion that is not owned', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${ABSENT_UUID}/messages`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s sending to a companion that is not owned', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${ABSENT_UUID}/messages`,
      headers: auth,
      payload: { content: 'hello' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty message with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: auth,
      payload: { content: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  // Empty-body tolerance must not bypass validation: a payload-required route
  // still rejects a missing body (now parsed as undefined, not a 400 parse error).
  it('rejects a missing message body with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('message content is required');
  });

  it('refuses a turn with 429 when the owner is over the daily token cap', async () => {
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    await ctx.deps.quota.recordUsage(owner.id, ctx.deps.config.tokenCapPerDay);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: auth,
      payload: { content: 'hello there' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/allowance/i);
    // The refused turn left no transcript behind.
    const messages = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    expect(messages.json().messages).toEqual([]);
  });

  it('streams an assistant reply and persists the transcript (end-to-end SSE)', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/companions/${companionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content: 'hello there' }),
    });
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('"type":"token"');
    expect(body).toContain('"type":"done"');

    // Transcript persisted: user turn + assistant turn.
    const messages = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    const transcript = messages.json().messages as Array<{
      role: string;
      content: string;
    }>;
    expect(transcript.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello there'],
      ['assistant', 'Hi there'],
    ]);

    // The turn's tokens (LLM + query embedding) are debited to the owner's cap.
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    const usage = await ctx.deps.quota.getUsage(owner.id);
    expect(usage.usedTokens).toBeGreaterThan(0);
  });
});
