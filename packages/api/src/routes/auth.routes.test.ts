import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

// The one HTTP `/auth` route is the public SPA bootstrap. Identifying the signed-in
// user is the WS `auth.me` method (covered in ws/methods.test.ts), and token
// rejection is the handshake/auth-guard's concern (auth-guard.test.ts).
describe('auth routes (Google)', () => {
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
      google_client_id: 'test-google-client-id',
    });
  });
});
