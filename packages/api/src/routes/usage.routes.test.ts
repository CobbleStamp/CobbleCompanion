/** Usage route: the signed-in user's daily token-budget standing. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('usage route', () => {
  let ctx: TestApp;
  let auth: { authorization: string };

  beforeEach(async () => {
    ctx = await makeTestApp();
    auth = ctx.bearerFor('owner@example.com');
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('reports the account standing with a clamped percent and reset instant', async () => {
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    await ctx.deps.quota.recordUsage(owner.id, ctx.deps.config.tokenCapPerDay / 2);

    const res = await ctx.app.inject({ method: 'GET', url: '/usage', headers: auth });
    expect(res.statusCode).toBe(200);
    const { usage } = res.json();
    expect(usage.usedTokens).toBe(ctx.deps.config.tokenCapPerDay / 2);
    expect(usage.capTokens).toBe(ctx.deps.config.tokenCapPerDay);
    expect(usage.percentUsed).toBe(50);
    expect(typeof usage.resetsAt).toBe('string');
  });

  it('clamps percent to 100 when over cap', async () => {
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    await ctx.deps.quota.recordUsage(owner.id, ctx.deps.config.tokenCapPerDay * 3);

    const res = await ctx.app.inject({ method: 'GET', url: '/usage', headers: auth });
    expect(res.json().usage.percentUsed).toBe(100);
  });
});
