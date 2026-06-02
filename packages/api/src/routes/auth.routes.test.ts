import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, signIn, type TestApp } from '../test/helpers.js';

describe('auth routes (magic link)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('issues a magic link and responds 200 without revealing the user', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email: 'ada@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.email.lastEmail).toBe('ada@example.com');
    expect(ctx.email.lastLink).toContain('/auth/verify?token=');
  });

  it('rejects a malformed email', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('verifies a token, sets a session, and identifies the user via /auth/me', async () => {
    const cookie = await signIn(ctx.app, ctx.email, 'ada@example.com');
    expect(cookie).toContain('cobble_session=');

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('ada@example.com');
  });

  it('redirects an invalid token back to the app with an error', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/auth/verify?token=bogus',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=invalid_link');
  });

  it('rejects /auth/me without a session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the session', async () => {
    const cookie = await signIn(ctx.app, ctx.email, 'ada@example.com');
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(out.statusCode).toBe(200);
    expect(out.headers['set-cookie']).toBeDefined();
  });

  it('a token cannot be reused', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email: 'ada@example.com' },
    });
    const token = new URL(ctx.email.lastLink ?? '').searchParams.get('token');
    const first = await ctx.app.inject({
      method: 'GET',
      url: `/auth/verify?token=${token}`,
    });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).not.toContain('error');

    const second = await ctx.app.inject({
      method: 'GET',
      url: `/auth/verify?token=${token}`,
    });
    expect(second.headers.location).toContain('error=invalid_link');
  });
});
