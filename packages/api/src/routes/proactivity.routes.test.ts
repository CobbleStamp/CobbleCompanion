/** Proactivity & vitality routes (Phase 4): budget meter, top-up, dial. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('proactivity routes', () => {
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

  it('reports both vitality pools', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/budget`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stamina.capTokens).toBe(ctx.deps.config.tokenCapPerDay);
    expect(body.stamina.usedTokens).toBe(0);
    expect(body.energy.capTokens).toBe(ctx.deps.config.tokenCapPerDay);
    expect(body.energy.percentUsed).toBe(0);
  });

  it('tops up the energy pool, raising its effective cap', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/budget/topup`,
      headers: auth,
      payload: { pool: 'energy', amount: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().energy.capTokens).toBe(ctx.deps.config.tokenCapPerDay + 5000);
  });

  it('tops up the stamina pool, raising its effective cap', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/budget/topup`,
      headers: auth,
      payload: { pool: 'stamina', amount: 3000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stamina.capTokens).toBe(ctx.deps.config.tokenCapPerDay + 3000);
  });

  it('rejects a non-positive or unknown-pool top-up', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/budget/topup`,
      headers: auth,
      payload: { pool: 'energy', amount: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('sets the proactivity dial', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/companions/${companionId}/proactivity`,
      headers: auth,
      payload: { dial: 'off' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dial).toBe('off');
    const companion = await ctx.deps.identity.getCompanionById(companionId);
    expect(companion?.proactivityDial).toBe('off');
  });

  it('rejects an invalid dial value', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/companions/${companionId}/proactivity`,
      headers: auth,
      payload: { dial: 'loud' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a companion the caller does not own', async () => {
    const headers = ctx.bearerFor('intruder@example.com');
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/budget`,
      headers,
    });
    expect(getRes.statusCode).toBe(404);
    const topupRes = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/budget/topup`,
      headers,
      payload: { pool: 'energy', amount: 100 },
    });
    expect(topupRes.statusCode).toBe(404);
    const dialRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/companions/${companionId}/proactivity`,
      headers,
      payload: { dial: 'off' },
    });
    expect(dialRes.statusCode).toBe(404);
  });
});
