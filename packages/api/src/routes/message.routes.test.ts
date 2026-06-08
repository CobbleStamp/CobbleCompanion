import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('refuses a turn with 429 when the companion is out of stamina', async () => {
    await ctx.deps.quota.spend(companionId, ctx.deps.config.startingVitalityTokens);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: auth,
      payload: { content: 'hello there' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/stamina/i);
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

    // The turn's tokens (LLM + query embedding) are debited from the companion's
    // stamina wallet, dropping its balance below the seeded start.
    const balance = await ctx.deps.quota.getBalance(companionId);
    expect(balance).toBeLessThan(ctx.deps.config.startingVitalityTokens);
  });

  // The fix for "growth, felt": when a turn crosses a growth band, the post-turn
  // recompute runs as the tail of THIS stream and the reflection is streamed in
  // place (a `reflection` event), not deferred to the next transcript fetch.
  it('streams a growth reflection in place when a turn crosses a band', async () => {
    // Seed enough substrate that the post-turn recompute crosses the knowledge band.
    for (let i = 0; i < 4; i += 1) {
      await ctx.deps.semantic.createSource(companionId, {
        kind: 'note',
        title: `note ${i}`,
        rawText: 'hello world',
      });
    }

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/companions/${companionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content: 'hello there' }),
    });
    const body = await response.text();

    // The reflection arrives in the same stream, after the reply's `done`.
    expect(body).toContain('"type":"reflection"');
    expect(body.indexOf('"type":"done"')).toBeLessThan(body.indexOf('"type":"reflection"'));

    // And it's a real persisted assistant turn — the live line equals a reload.
    const messages = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    const roles = (messages.json().messages as Array<{ role: string }>).map((m) => m.role);
    // user + assistant reply + at least one growth reflection.
    expect(roles.filter((r) => r === 'assistant').length).toBeGreaterThanOrEqual(2);
  });

  // Opening the transcript is a "return" trigger (P4): the GET handler nudges the
  // motivation engine before responding, so this fires within inject.
  it('nudges the motivation engine when the transcript is opened (return trigger)', async () => {
    const requested: string[] = [];
    ctx.deps.motivation.request = (id: string): void => {
      requested.push(id);
    };
    await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    expect(requested).toContain(companionId);
  });

  // A completed turn also nudges the engine (activity tick), fired after the SSE
  // stream — so drain the real stream before asserting (mirrors consolidation).
  it('nudges the motivation engine after a sent turn', async () => {
    const requested: string[] = [];
    ctx.deps.motivation.request = (id: string): void => {
      requested.push(id);
    };
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/companions/${companionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content: 'hello there' }),
    });
    await response.text(); // drain the SSE stream so the trigger has fired

    expect(requested).toContain(companionId);
  });

  // The background reflection pass is nudged once per completed turn (fired
  // after the reply has streamed, fire-and-forget). We wrap the runner's
  // `request` with a delegating spy so the real coalesce/cap logic still runs.
  it('requests background consolidation after a successful turn', async () => {
    const original = ctx.deps.consolidation.request.bind(ctx.deps.consolidation);
    const requestSpy = vi
      .spyOn(ctx.deps.consolidation, 'request')
      .mockImplementation((id: string) => original(id));

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/companions/${companionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content: 'hello there' }),
    });
    await response.text(); // drain the SSE stream so the trigger has fired

    expect(requestSpy).toHaveBeenCalledWith(companionId);
  });

  // The out-of-stamina wall is a clean 429 with no turn run, so there's nothing new
  // to reflect — the consolidation nudge must not fire on a refused turn.
  it('does not request consolidation when the turn is refused out of stamina', async () => {
    const requestSpy = vi.spyOn(ctx.deps.consolidation, 'request').mockImplementation(() => {});

    await ctx.deps.quota.spend(companionId, ctx.deps.config.startingVitalityTokens);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: auth,
      payload: { content: 'hello there' },
    });

    expect(res.statusCode).toBe(429);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
