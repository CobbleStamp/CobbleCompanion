import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('memory routes', () => {
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

  it('returns a sectioned snapshot with the episodic transcript and planned sections', async () => {
    await ctx.deps.memory.appendMessage(companionId, 'user', 'hello');
    await ctx.deps.memory.appendMessage(companionId, 'assistant', 'hi');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { memory } = res.json();
    expect(memory.identity.id).toBe(companionId);
    expect(memory.episodic.status).toBe('available');
    expect(memory.episodic.messageCount).toBe(2);
    expect(memory.semantic.status).toBe('not_implemented');
    expect(memory.procedural.status).toBe('not_implemented');
  });

  it('404s the snapshot when the companion is not owned', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${ABSENT_UUID}/memory`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not expose another owner's companion memory", async () => {
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
  });
});
