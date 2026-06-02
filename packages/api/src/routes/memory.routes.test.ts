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
    const conv = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/conversations`,
      headers: auth,
    });
    const conversationId = conv.json().conversation.id;
    await ctx.deps.memory.appendMessage(conversationId, 'user', 'hello');
    await ctx.deps.memory.appendMessage(conversationId, 'assistant', 'hi');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { memory } = res.json();
    expect(memory.identity.id).toBe(companionId);
    expect(memory.episodic.status).toBe('available');
    expect(memory.episodic.conversationCount).toBe(1);
    expect(memory.episodic.messageCount).toBe(2);
    expect(memory.episodic.conversations[0]).toMatchObject({
      id: conversationId,
      messageCount: 2,
    });
    expect(memory.semantic.status).toBe('not_implemented');
    expect(memory.procedural.status).toBe('not_implemented');
  });

  it('lists a companion conversations', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/conversations`,
      headers: auth,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/conversations`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversations).toHaveLength(1);
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
