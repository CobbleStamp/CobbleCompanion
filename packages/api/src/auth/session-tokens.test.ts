import { describe, expect, it } from 'vitest';
import type { AuthRequest } from './jwt-verifier.js';
import {
  AppSessionVerifier,
  mintAccessToken,
  mintRefreshToken,
  type SessionIdentity,
  verifyRefreshToken,
} from './session-tokens.js';

const SECRET = 'test-signing-secret-at-least-32-bytes-long!!';
const OTHER_SECRET = 'a-different-signing-secret-also-32-bytes-xx!!';
const ALICE: SessionIdentity = { authSource: 'google', email: 'alice@example.com' };

function bearer(token: string): AuthRequest {
  return {
    authorization: `Bearer ${token}`,
    header: () => undefined,
  };
}

describe('session-tokens access verification', () => {
  it('round-trips a minted access token to its identity', async () => {
    const token = mintAccessToken(ALICE, SECRET, 900);
    const verifier = new AppSessionVerifier(SECRET);

    const claims = await verifier.verify(bearer(token));

    expect(claims).toEqual({ ok: true, identity: ALICE });
  });

  it('classifies an expired access token as kind:expired', async () => {
    // Minted at t=1000 with a 900s ttl (exp=1900); verified at t=2000.
    const token = mintAccessToken(ALICE, SECRET, 900, 1000);
    const verifier = new AppSessionVerifier(SECRET, () => 2000);

    const claims = await verifier.verify(bearer(token));

    expect(claims.ok).toBe(false);
    if (!claims.ok) expect(claims.failure.kind).toBe('expired');
  });

  it('rejects a token signed with a different secret as invalid', async () => {
    const token = mintAccessToken(ALICE, OTHER_SECRET, 900);
    const verifier = new AppSessionVerifier(SECRET);

    const claims = await verifier.verify(bearer(token));

    expect(claims.ok).toBe(false);
    if (!claims.ok) expect(claims.failure.kind).toBe('invalid');
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const token = mintAccessToken(ALICE, SECRET, 900);
    const [head, , sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'mallory@example.com', typ: 'access', iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    const verifier = new AppSessionVerifier(SECRET);

    const claims = await verifier.verify(bearer(`${head}.${forged}.${sig}`));

    expect(claims.ok).toBe(false);
  });

  it('refuses a refresh token presented as an access token (typ confusion)', async () => {
    const refresh = mintRefreshToken(ALICE, SECRET, 86_400);
    const verifier = new AppSessionVerifier(SECRET);

    const claims = await verifier.verify(bearer(refresh));

    expect(claims.ok).toBe(false);
    if (!claims.ok) expect(claims.failure.kind).toBe('invalid');
  });

  it('rejects a missing bearer', async () => {
    const verifier = new AppSessionVerifier(SECRET);

    const claims = await verifier.verify({ authorization: undefined, header: () => undefined });

    expect(claims.ok).toBe(false);
  });
});

describe('session-tokens refresh verification', () => {
  it('round-trips a minted refresh token to its identity', () => {
    const token = mintRefreshToken(ALICE, SECRET, 86_400);

    expect(verifyRefreshToken(token, SECRET)).toEqual({ ok: true, identity: ALICE });
  });

  it('rejects an expired refresh token', () => {
    const token = mintRefreshToken(ALICE, SECRET, 100, 1000); // exp=1100

    expect(verifyRefreshToken(token, SECRET, 2000)).toEqual({ ok: false });
  });

  it('refuses an access token presented as a refresh token (typ confusion)', () => {
    const access = mintAccessToken(ALICE, SECRET, 900);

    expect(verifyRefreshToken(access, SECRET)).toEqual({ ok: false });
  });

  it('rejects a refresh token signed with a different secret', () => {
    const token = mintRefreshToken(ALICE, OTHER_SECRET, 86_400);

    expect(verifyRefreshToken(token, SECRET)).toEqual({ ok: false });
  });
});
