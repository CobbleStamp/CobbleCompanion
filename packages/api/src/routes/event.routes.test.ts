/**
 * The standing companion event channel route (architecture.md §6): auth and
 * ownership guards. The push mechanics — a published row arriving as a `message`
 * frame, heartbeats, and close-cleanup — are covered against a real bus in
 * `sse.test.ts` (`streamChannel`); they can't go through `inject`, which buffers
 * the whole response while a standing stream never ends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

/** A syntactically valid UUID that no companion will own (→ 404). */
const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('event channel routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
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

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/companions/${companionId}/events` });
    expect(res.statusCode).toBe(401);
  });

  it("404s for a companion the caller doesn't own", async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${ABSENT_UUID}/events`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
