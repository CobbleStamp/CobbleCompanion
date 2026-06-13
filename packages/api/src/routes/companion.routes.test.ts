import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

/**
 * Auth headers for a service consumer's user. The real `ServiceTokenVerifier` +
 * registry are tested in auth/jwt-verifier.test.ts and identity/service-registry.test.ts;
 * here we register the service claim they would produce so the guard →
 * `ensureUserByClaim` → scoped-route path is exercised.
 */
function serviceAuth(
  ctx: TestApp,
  clientId: string,
  externalId: string,
): { authorization: string } {
  const token = `svc-${clientId}-${externalId}`;
  ctx.tokenVerifier.set(token, {
    ok: true,
    identity: { authSource: 'service', clientId, externalId },
  });
  return { authorization: `Bearer ${token}` };
}

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

  it('provisions a service consumer user and scopes it like any other', async () => {
    const uid = '11111111-2222-4333-8444-555555555555';
    const sprout = serviceAuth(ctx, 'sprout', uid);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: sprout,
      payload: { name: 'Sprout', form: 'fox', temperament: 'curious' },
    });
    expect(created.statusCode).toBe(201);

    const own = await ctx.app.inject({ method: 'GET', url: '/companions', headers: sprout });
    expect(own.json().companions).toHaveLength(1);

    // A different external_id is a different user — its list is empty (tenancy holds).
    const otherUser = serviceAuth(ctx, 'sprout', '22222222-3333-4444-8555-666666666666');
    const other = await ctx.app.inject({ method: 'GET', url: '/companions', headers: otherUser });
    expect(other.json().companions).toHaveLength(0);

    // The SAME external_id under a DIFFERENT client is a DIFFERENT user — the client_id
    // namespaces the id, so a second consumer reusing the UUID sees nothing.
    const otherClient = serviceAuth(ctx, 'acme', uid);
    const acme = await ctx.app.inject({ method: 'GET', url: '/companions', headers: otherClient });
    expect(acme.json().companions).toHaveLength(0);
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
