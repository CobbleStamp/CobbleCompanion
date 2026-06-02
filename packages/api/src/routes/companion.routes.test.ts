import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('companion routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };

  beforeEach(async () => {
    ctx = await makeTestApp();
    auth = ctx.bearerFor('owner@example.com');
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates and lists a companion for the owner', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().companion.name).toBe('Pebble');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/companions',
      headers: auth,
    });
    expect(list.json().companions).toHaveLength(1);
  });

  it('rejects an invalid companion', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: '', form: 'fox', temperament: 'curious' },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not leak another user's companions", async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    const otherAuth = ctx.bearerFor('other@example.com');
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/companions',
      headers: otherAuth,
    });
    expect(list.json().companions).toHaveLength(0);
  });
});
