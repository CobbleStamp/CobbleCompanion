/**
 * The HTTP `/auth` surface (implementation.md §5): the public SPA bootstrap plus the
 * app-managed session exchange. `POST /auth/session` trades a verified Google ID token
 * for an app access token + a refresh cookie; `POST /auth/refresh` mints a fresh access
 * token from that cookie (no Google round-trip); `POST /auth/logout` clears it. After
 * the exchange the browser bearer is the app access token — a Google ID token no longer
 * authenticates an ordinary request (only `/auth/session` accepts it).
 *
 * The auth/admin gate itself is covered by auth-guard.test.ts; here we use
 * `GET /admin/queue` only as a convenient always-registered authenticated route, where
 * 401 means "not authenticated" and 403 means "authenticated, but not an admin" — the
 * latter proving a token was accepted by the per-request verifier.
 */

import type { AuthClaims } from '../auth/jwt-verifier.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const GOOGLE_CLAIM: AuthClaims = {
  ok: true,
  identity: { authSource: 'google', email: 'alice@example.com' },
  seedName: 'Alice',
};

/** The refresh cookie value from a `set-cookie` header list, or undefined. */
function refreshCookie(setCookie: string | string[] | undefined): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((h) => h.startsWith('cobble.refresh='));
  return match?.split(';')[0]?.slice('cobble.refresh='.length);
}

describe('GET /auth/config', () => {
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
    expect(res.json()).toEqual({ google_client_id: 'test-google-client-id' });
  });
});

describe('POST /auth/session', () => {
  let harness: TestApp;
  beforeEach(async () => {
    harness = await makeTestApp();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('exchanges a valid Google ID token for an access token + HttpOnly refresh cookie', async () => {
    harness.googleVerifier.set('google-id-token', GOOGLE_CLAIM);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { authorization: 'Bearer google-id-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string; token_type: string; expires_in: number };
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token.split('.')).toHaveLength(3);
    const cookieHeader = String(res.headers['set-cookie'] ?? '');
    expect(cookieHeader).toContain('cobble.refresh=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Path=/auth');
  });

  it('provisions the user from the Google claim', async () => {
    harness.googleVerifier.set('google-id-token', GOOGLE_CLAIM);

    await harness.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { authorization: 'Bearer google-id-token' },
    });

    const user = await harness.deps.identity.ensureUserByEmail('alice@example.com');
    expect(user.email).toBe('alice@example.com');
  });

  it('rejects an unrecognised Google ID token with 401 and sets no cookie', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a request with no bearer', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/auth/session' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  let harness: TestApp;
  beforeEach(async () => {
    harness = await makeTestApp();
    harness.googleVerifier.set('google-id-token', GOOGLE_CLAIM);
  });
  afterEach(async () => {
    await harness.close();
  });

  /** Run the session exchange and return the refresh cookie it sets. */
  async function establishSession(): Promise<string> {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { authorization: 'Bearer google-id-token' },
    });
    const cookie = refreshCookie(res.headers['set-cookie']);
    if (!cookie) throw new Error('session did not set a refresh cookie');
    return cookie;
  }

  it('mints a fresh, working access token from the refresh cookie', async () => {
    const cookie = await establishSession();

    const res = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { 'cobble.refresh': cookie },
    });

    expect(res.statusCode).toBe(200);
    const accessToken = (res.json() as { access_token: string }).access_token;
    // 403 (not 401): the token authenticated alice; she's just not an admin.
    const authed = await harness.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(authed.statusCode).toBe(403);
  });

  it('rejects a request with no refresh cookie (401)', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a garbage refresh cookie and clears it', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { 'cobble.refresh': 'not.a.token' },
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['set-cookie'] ?? '')).toContain('cobble.refresh=');
  });
});

describe('browser bearer is the app access token, not the Google ID token', () => {
  let harness: TestApp;
  beforeEach(async () => {
    harness = await makeTestApp();
    harness.googleVerifier.set('google-id-token', GOOGLE_CLAIM);
  });
  afterEach(async () => {
    await harness.close();
  });

  it('rejects a Google ID token presented to an ordinary authenticated route (401)', async () => {
    // 'google-id-token' is valid only at /auth/session; the per-request verifier is
    // the AppSessionVerifier, which does not recognise it.
    const res = await harness.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: { authorization: 'Bearer google-id-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the app access token minted by the exchange (authenticated → 403, not 401)', async () => {
    const session = await harness.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { authorization: 'Bearer google-id-token' },
    });
    const accessToken = (session.json() as { access_token: string }).access_token;

    const res = await harness.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /auth/logout', () => {
  let harness: TestApp;
  beforeEach(async () => {
    harness = await makeTestApp();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('clears the refresh cookie', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'] ?? '')).toContain('cobble.refresh=');
  });
});

describe('CSRF: /auth POST routes pin the Origin', () => {
  let harness: TestApp;
  beforeEach(async () => {
    harness = await makeTestApp(); // testConfig.appUrl === 'http://localhost:3001'
  });
  afterEach(async () => {
    await harness.close();
  });

  it('rejects a cross-site Origin on /auth/refresh, /auth/session, /auth/logout (403)', async () => {
    const evil = { origin: 'https://evil.example' };
    for (const url of ['/auth/refresh', '/auth/session', '/auth/logout']) {
      const res = await harness.app.inject({ method: 'POST', url, headers: evil });
      expect(res.statusCode).toBe(403);
    }
  });

  it('allows the configured app origin on /auth/logout', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: 'http://localhost:3001' },
    });
    expect(res.statusCode).toBe(204);
  });
});
