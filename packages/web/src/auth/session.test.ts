import { afterEach, describe, expect, it } from 'vitest';
import { clearStoredToken, isTokenExpired, loadStoredToken, storeToken } from './session.js';

/** Build a minimal unsigned JWT carrying just the given `exp` (seconds). */
function tokenWithExp(expSeconds: number | null): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify(expSeconds === null ? {} : { exp: expSeconds }));
  return `${header}.${payload}.sig`;
}

const NOW_MS = 1_780_512_000_000;
// Far-future / far-past so the persistence tests (which read the real clock via
// loadStoredToken) don't flake as wall-clock time advances.
const future = tokenWithExp(4_102_444_800); // year 2100
const past = tokenWithExp(946_684_800); // year 2000

afterEach(() => {
  sessionStorage.clear();
});

describe('isTokenExpired', () => {
  it('treats a token whose exp is in the future as valid', () => {
    expect(isTokenExpired(future, NOW_MS)).toBe(false);
  });

  it('treats a token whose exp has passed as expired', () => {
    expect(isTokenExpired(past, NOW_MS)).toBe(true);
  });

  it('treats a token without a readable exp as expired', () => {
    expect(isTokenExpired(tokenWithExp(null), NOW_MS)).toBe(true);
    expect(isTokenExpired('not-a-jwt', NOW_MS)).toBe(true);
  });
});

describe('token persistence', () => {
  it('round-trips a stored token', () => {
    storeToken(future);
    expect(loadStoredToken()).toBe(future);
  });

  it('returns null and clears storage when the stored token is expired', () => {
    storeToken(past);
    expect(loadStoredToken()).toBeNull();
    expect(sessionStorage.getItem('cobble.idToken')).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(loadStoredToken()).toBeNull();
  });

  it('clearStoredToken removes the persisted token', () => {
    storeToken(future);
    clearStoredToken();
    expect(loadStoredToken()).toBeNull();
  });
});
