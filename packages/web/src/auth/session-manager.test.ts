import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResult } from '../api/auth.js';
import { SessionManager, type SessionApi } from './session-manager.js';

const NOW_MS = 1_780_512_000_000;

/** A valid-looking access token whose exp is `secondsFromNow` past NOW_MS. */
function tokenExpiringIn(secondsFromNow: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(NOW_MS / 1000) + secondsFromNow }));
  return `${header}.${payload}.sig`;
}

const FRESH = tokenExpiringIn(3600);
const REFRESHED = tokenExpiringIn(7200);

class FakeSessionApi implements SessionApi {
  sessionResult: SessionResult = { ok: false, reason: 'error' };
  refreshResult: SessionResult = { ok: false, reason: 'error' };
  sessionCalls = 0;
  refreshCalls = 0;
  logoutCalls = 0;

  async postSession(): Promise<SessionResult> {
    this.sessionCalls += 1;
    return this.sessionResult;
  }
  async postRefresh(): Promise<SessionResult> {
    this.refreshCalls += 1;
    return this.refreshResult;
  }
  async postLogout(): Promise<void> {
    this.logoutCalls += 1;
  }
}

describe('SessionManager', () => {
  let api: FakeSessionApi;
  let manager: SessionManager;

  beforeEach(() => {
    api = new FakeSessionApi();
    manager = new SessionManager(api, () => NOW_MS);
  });

  it('returns the cached access token without refreshing while it is fresh', async () => {
    api.sessionResult = { ok: true, accessToken: FRESH };
    await manager.signIn('google-id-token');

    const token1 = await manager.getAccessToken();
    const token2 = await manager.getAccessToken();

    expect(token1).toBe(FRESH);
    expect(token2).toBe(FRESH);
    expect(api.refreshCalls).toBe(0);
  });

  it('refreshes when no token is held yet', async () => {
    api.refreshResult = { ok: true, accessToken: REFRESHED };

    const token = await manager.getAccessToken();

    expect(token).toBe(REFRESHED);
    expect(api.refreshCalls).toBe(1);
  });

  it('refreshes a token that is within the skew window of its expiry', async () => {
    api.sessionResult = { ok: true, accessToken: tokenExpiringIn(10) }; // expires in 10s (< 30s skew)
    api.refreshResult = { ok: true, accessToken: REFRESHED };
    await manager.signIn('google-id-token');

    const token = await manager.getAccessToken();

    expect(token).toBe(REFRESHED);
    expect(api.refreshCalls).toBe(1);
  });

  it('fires the expire handler and returns null when refresh is unauthorized', async () => {
    api.refreshResult = { ok: false, reason: 'unauthorized' };
    const onExpire = vi.fn();
    manager.setOnExpire(onExpire);

    const token = await manager.getAccessToken();

    expect(token).toBeNull();
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('does NOT fire the expire handler on a transient refresh error', async () => {
    api.refreshResult = { ok: false, reason: 'error' };
    const onExpire = vi.fn();
    manager.setOnExpire(onExpire);

    const token = await manager.getAccessToken();

    expect(token).toBeNull();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('de-duplicates concurrent refreshes into a single request', async () => {
    api.refreshResult = { ok: true, accessToken: REFRESHED };

    const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);

    expect(a).toBe(REFRESHED);
    expect(b).toBe(REFRESHED);
    expect(api.refreshCalls).toBe(1);
  });

  it('signIn stores the access token on success and reports failure otherwise', async () => {
    api.sessionResult = { ok: false, reason: 'unauthorized' };
    expect(await manager.signIn('bad')).toBe(false);

    api.sessionResult = { ok: true, accessToken: FRESH };
    expect(await manager.signIn('good')).toBe(true);
    expect(await manager.getAccessToken()).toBe(FRESH);
    expect(api.refreshCalls).toBe(0);
  });

  it('restore reports session presence without firing the expire handler', async () => {
    const onExpire = vi.fn();
    manager.setOnExpire(onExpire);

    api.refreshResult = { ok: false, reason: 'unauthorized' };
    expect(await manager.restore()).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();

    api.refreshResult = { ok: true, accessToken: REFRESHED };
    expect(await manager.restore()).toBe(true);
  });

  it('signOut clears the token and clears the server-side cookie', async () => {
    api.sessionResult = { ok: true, accessToken: FRESH };
    await manager.signIn('google-id-token');

    await manager.signOut();

    expect(api.logoutCalls).toBe(1);
    // With no token held and refresh unauthorized, getAccessToken yields null.
    api.refreshResult = { ok: false, reason: 'unauthorized' };
    expect(await manager.getAccessToken()).toBeNull();
  });
});
