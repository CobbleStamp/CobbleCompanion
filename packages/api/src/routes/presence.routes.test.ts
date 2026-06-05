/** Presence heartbeat route (Phase 4): owner-scoping, 404, and that it records. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('presence routes', () => {
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

  it('records a heartbeat and returns 204', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/heartbeat`,
      headers: auth,
      payload: { tabVisible: false },
    });
    expect(res.statusCode).toBe(204);
    const signal = ctx.deps.presence.get(companionId);
    expect(signal?.tabVisible).toBe(false);
  });

  it('defaults tabVisible to true when omitted', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/heartbeat`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.deps.presence.get(companionId)?.tabVisible).toBe(true);
  });

  it('404s for a companion the caller does not own', async () => {
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/heartbeat`,
      headers: otherAuth,
      payload: { tabVisible: true },
    });
    expect(res.statusCode).toBe(404);
    // The owner's presence was not touched by the intruder's call.
    expect(ctx.deps.presence.get(companionId)).toBeNull();
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/heartbeat`,
      payload: { tabVisible: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
