import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UserClaim } from '@cobble/core';
import type { AuthClaims, AuthRequest, AuthSurface, TokenVerifier } from './jwt-verifier.js';
import { bearerToken } from './jwt-verifier.js';

/**
 * App-issued session tokens (implementation.md §5). A Google ID token is verified
 * once at `POST /auth/session`; the API then mints its OWN short-lived **access**
 * token and a longer-lived **refresh** token, both HS256-signed with
 * `JWT_SIGNING_SECRET`. This decouples session lifetime from Google's ~1h ID token:
 * the browser refreshes against `/auth/refresh` (no Google round-trip) until the
 * refresh token's `exp`, and only re-authenticates with Google after that.
 *
 * Stateless by design — no session table, consistent with the repo's per-request
 * auth model. Trade-off: there is **no server-side revocation** before `exp`;
 * sign-out clears the client's refresh cookie but a leaked token stays valid until
 * it expires. Refresh-token rotation + reuse-detection (which needs server state) is
 * the documented future step. The two token kinds carry a `typ` claim so one cannot
 * be presented in the other's place (a refresh token can't authenticate a request,
 * and an access token can't be refreshed).
 */

/** The only identity a browser session represents: a Google-authenticated user.
 *  (Service callers authenticate per-request and never mint a session.) */
export type SessionIdentity = Extract<UserClaim, { authSource: 'google' }>;

/** Which kind of token: an `access` token authenticates requests; a `refresh`
 *  token is presented only to `/auth/refresh` to mint a new access token. */
export type SessionTokenType = 'access' | 'refresh';

/** The verified payload of a refresh token, or a typed failure. Mirrors the repo's
 *  `ok`-tagged result shape so the caller must branch (no bare-null failure). */
export type RefreshVerification =
  | { readonly ok: true; readonly identity: SessionIdentity }
  | { readonly ok: false };

interface SessionTokenPayload {
  readonly sub: string; // the user's email (the Google identity key)
  readonly typ: SessionTokenType;
  readonly iat: number;
  readonly exp: number;
  /** Absent = full web session. `discord` = scoped to the Discord bridge (HTTP-guard
   *  rejected). Signed into the token, so it can't be added/removed after minting. */
  readonly surface?: AuthSurface;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Mint a signed session token of `type` for `identity`, expiring `ttlSec` from
 *  `issuedAtSec`. Synchronous (HMAC) so test helpers can build bearers inline. */
function mint(
  type: SessionTokenType,
  identity: SessionIdentity,
  secret: string,
  ttlSec: number,
  issuedAtSec: number = nowSeconds(),
  surface?: AuthSurface,
): string {
  const payload: SessionTokenPayload = {
    sub: identity.email,
    typ: type,
    iat: issuedAtSec,
    exp: issuedAtSec + ttlSec,
    ...(surface ? { surface } : {}),
  };
  const head = base64url(JSON.stringify(HEADER));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${head}.${body}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

/** Mint a short-lived access token (sent to the client, used as the API bearer). */
export function mintAccessToken(
  identity: SessionIdentity,
  secret: string,
  ttlSec: number,
  issuedAtSec?: number,
): string {
  return mint('access', identity, secret, ttlSec, issuedAtSec);
}

/**
 * Mint a short-lived access token **scoped to a non-web surface** (currently only
 * `discord`). Identical to {@link mintAccessToken} but the `surface` claim is signed in,
 * so the HTTP auth guard can reject it (a Discord token must only reach `/ws`). Used by
 * the Discord token-mint; the web session path uses the unscoped {@link mintAccessToken}.
 */
export function mintSurfaceAccessToken(
  identity: SessionIdentity,
  surface: AuthSurface,
  secret: string,
  ttlSec: number,
  issuedAtSec?: number,
): string {
  return mint('access', identity, secret, ttlSec, issuedAtSec, surface);
}

/** Mint a longer-lived refresh token (stored in the HttpOnly cookie). */
export function mintRefreshToken(
  identity: SessionIdentity,
  secret: string,
  ttlSec: number,
  issuedAtSec?: number,
): string {
  return mint('refresh', identity, secret, ttlSec, issuedAtSec);
}

/** Verify a token's signature, expiry, and `typ`. Returns the decoded payload on
 *  success, or a discriminated failure (`expired` distinguished so callers can log
 *  routine churn at `info`, matching the Google-token path). */
function verify(
  token: string,
  secret: string,
  expected: SessionTokenType,
  nowSec: number,
):
  | { readonly ok: true; readonly payload: SessionTokenPayload }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' } {
  const parts = token.split('.');
  const [head, body, providedSig] = parts;
  if (parts.length !== 3 || head === undefined || body === undefined || providedSig === undefined) {
    return { ok: false, reason: 'invalid' };
  }
  const expectedSig = sign(`${head}.${body}`, secret);
  const provided = Buffer.from(providedSig, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  // Length check first: timingSafeEqual throws on unequal lengths.
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return { ok: false, reason: 'invalid' };
  }
  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (payload.typ !== expected || typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

/**
 * Verifies the API's own **access** tokens — the browser-bearer branch of the
 * composite verifier (jwt-verifier.ts) once a session has been minted. Returns the
 * existing {@link AuthClaims} union so the auth guard is unchanged: a valid token
 * yields the Google {@link UserClaim} (resolved to a user by `ensureUserByClaim`),
 * an expired one yields `kind: 'expired'` (logged at `info`), anything else
 * `kind: 'invalid'`.
 */
export class AppSessionVerifier implements TokenVerifier {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = nowSeconds,
  ) {}

  async verify(request: AuthRequest): Promise<AuthClaims> {
    const token = bearerToken(request.authorization);
    if (!token) {
      return {
        ok: false,
        failure: { status: 401, kind: 'invalid', message: 'authentication required' },
      };
    }
    const result = verify(token, this.secret, 'access', this.now());
    if (!result.ok) {
      return {
        ok: false,
        failure: {
          status: 401,
          kind: result.reason,
          message: result.reason === 'expired' ? 'token expired' : 'invalid token',
        },
      };
    }
    return {
      ok: true,
      identity: { authSource: 'google', email: result.payload.sub },
      // Propagate the surface scope (only `discord` is valid) so the HTTP guard can
      // refuse a non-web token. Trusted because it is HMAC-signed into the token.
      ...(result.payload.surface === 'discord' ? { surface: 'discord' as const } : {}),
    };
  }
}

/** Verify a refresh token presented to `/auth/refresh`. Pure (no request adaptor)
 *  because the token comes from the HttpOnly cookie, not an Authorization header. */
export function verifyRefreshToken(
  token: string,
  secret: string,
  nowSec: number = nowSeconds(),
): RefreshVerification {
  const result = verify(token, secret, 'refresh', nowSec);
  if (!result.ok) {
    return { ok: false };
  }
  return { ok: true, identity: { authSource: 'google', email: result.payload.sub } };
}
