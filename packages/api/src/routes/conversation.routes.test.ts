import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, signIn, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('conversation routes', () => {
  let ctx: TestApp;
  let cookie: string;
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(['Hi', ' there']);
    cookie = await signIn(ctx.app, ctx.email, 'owner@example.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: { cookie },
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    companionId = created.json().companion.id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('creates a conversation for an owned companion', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/conversations`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().conversation.companionId).toBe(companionId);
  });

  it('404s when the companion is not owned', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${ABSENT_UUID}/conversations`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty message with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/conversations/${ABSENT_UUID}/messages`,
      headers: { cookie },
      payload: { content: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('streams an assistant reply and persists the transcript (end-to-end SSE)', async () => {
    const convRes = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/conversations`,
      headers: { cookie },
    });
    const conversationId = convRes.json().conversation.id;

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${port}/companions/${companionId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ content: 'hello there' }),
      },
    );
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('"type":"token"');
    expect(body).toContain('"type":"done"');

    // Transcript persisted: user turn + assistant turn.
    const messages = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/conversations/${conversationId}/messages`,
      headers: { cookie },
    });
    const transcript = messages.json().messages as Array<{
      role: string;
      content: string;
    }>;
    expect(transcript.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello there'],
      ['assistant', 'Hi there'],
    ]);
  });
});
