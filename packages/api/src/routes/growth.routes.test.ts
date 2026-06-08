/**
 * Growth/feeding routes at the surface boundary: auth is enforced, the food pantry
 * is per-user (one user's feeding never touches another's), and the removed
 * `POST /budget/topup` (the old buy-stamina route, deleted with the feed-only wallet
 * model) is gone. Feed mechanics + 409/400 live in `phase5-dod.test.ts`; this file
 * owns the cross-cutting boundary checks.
 */

import { DEFAULT_GROWTH_CONFIG } from '@cobble/core';
import type { FoodInventoryDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('growth/feeding routes — boundary', () => {
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

  async function pantryFor(headers: { authorization: string }): Promise<FoodInventoryDto> {
    const res = await ctx.app.inject({ method: 'GET', url: '/food', headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { food: FoodInventoryDto }).food;
  }

  it('GET /food requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/food' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /feed requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/feed`,
      payload: { food: 'ration' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("feeding from one user's pantry never touches another user's (per-user isolation)", async () => {
    // A second user with their own (empty of companions, but seeded) pantry.
    const otherAuth = ctx.bearerFor('other@example.com');

    // Owner feeds their companion, consuming one ration from the OWNER's pantry.
    const fed = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/feed`,
      headers: auth,
      payload: { food: 'ration' },
    });
    expect(fed.statusCode).toBe(200);

    // Owner's pantry dropped by one; the other user's pantry is seeded full and
    // entirely untouched — food is scoped to the user, not shared across accounts.
    expect((await pantryFor(auth)).ration).toBe(DEFAULT_GROWTH_CONFIG.initialFood - 1);
    expect((await pantryFor(otherAuth)).ration).toBe(DEFAULT_GROWTH_CONFIG.initialFood);
  });

  it('the removed POST /budget/topup route no longer exists (404)', async () => {
    // The feed-only wallet model dropped buying/topping-up stamina: replenishment is
    // by feeding alone. The old top-up route must be gone, not silently re-added.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/budget/topup`,
      headers: auth,
      payload: { tokens: 100_000 },
    });
    expect(res.statusCode).toBe(404);
  });
});
