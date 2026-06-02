import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('auth routes (Auth0)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('serves the public SPA bootstrap config', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: 'auth0',
      auth0_domain: 'test.auth0.local',
      auth0_client_id: 'test-client-id',
      auth0_audience: 'https://api.cobble.test',
    });
  });

  it('identifies the user via /auth/me with a valid bearer token', async () => {
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: ctx.bearerFor('ada@example.com'),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('ada@example.com');
  });

  it('rejects /auth/me without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects /auth/me with an unknown token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer bogus' },
    });
    expect(res.statusCode).toBe(401);
  });
});
