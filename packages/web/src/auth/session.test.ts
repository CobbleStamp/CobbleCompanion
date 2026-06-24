import { describe, expect, it } from 'vitest';
import { isTokenExpired } from './session.js';

/** Build a minimal unsigned JWT carrying just the given `exp` (seconds). */
function tokenWithExp(expSeconds: number | null): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify(expSeconds === null ? {} : { exp: expSeconds }));
  return `${header}.${payload}.sig`;
}

const NOW_MS = 1_780_512_000_000;
const future = tokenWithExp(Math.floor(NOW_MS / 1000) + 3600);
const past = tokenWithExp(Math.floor(NOW_MS / 1000) - 3600);

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

  it('fails closed on a malformed token missing a segment', () => {
    // A 2-segment token (empty header) must not be read as live, even if it carries exp.
    const payload = btoa(JSON.stringify({ exp: Math.floor(NOW_MS / 1000) + 3600 }));
    expect(isTokenExpired(`.${payload}.sig`, NOW_MS)).toBe(true);
    expect(isTokenExpired(`${payload}.sig`, NOW_MS)).toBe(true);
  });

  it('treats a token within the skew window as expired when now is shifted forward', () => {
    // exp is 10s out; checking with now+30s skew classifies it as already expired.
    const soon = tokenWithExp(Math.floor(NOW_MS / 1000) + 10);
    expect(isTokenExpired(soon, NOW_MS)).toBe(false);
    expect(isTokenExpired(soon, NOW_MS + 30_000)).toBe(true);
  });
});
