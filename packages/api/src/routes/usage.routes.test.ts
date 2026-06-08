/** Usage route: a companion's stamina-wallet standing. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('usage route', () => {
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
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/usage`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a companion the caller does not own', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/companions/00000000-0000-0000-0000-000000000000/usage',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('reports the remaining wallet balance after a spend', async () => {
    const start = ctx.deps.config.startingVitalityTokens;
    await ctx.deps.quota.spend(companionId, start / 2);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/usage`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { usage } = res.json();
    expect(usage.balanceTokens).toBe(start / 2);
  });

  it('reports a floored-at-zero balance when the wallet is overspent', async () => {
    const start = ctx.deps.config.startingVitalityTokens;
    await ctx.deps.quota.spend(companionId, start * 3); // overspend

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/usage`,
      headers: auth,
    });
    expect(res.json().usage.balanceTokens).toBe(0);
  });
});
