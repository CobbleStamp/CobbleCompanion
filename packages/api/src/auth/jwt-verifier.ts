import type { ServiceRegistry, UserClaim } from '@cobble/core';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

/**
 * The minimal, Fastify-free view of a request a verifier needs. The auth guard
 * adapts the `FastifyRequest` to this so verifiers stay unit-testable with a plain
 * object (fakes-over-mocks) and don't depend on the web framework.
 */
export interface AuthRequest {
  /** Raw `Authorization` header value, if present. */
  readonly authorization: string | undefined;
  /** Case-insensitive lookup of an arbitrary header (e.g. `x-user-id`). */
  header(name: string): string | undefined;
}

/**
 * Why authentication failed. `kind` drives the guard's log level — `expired` is
 * routine client churn (logged at `info`, no stack), everything else is a genuine
 * anomaly (logged at `error`). `message` is client-safe; `cause` (the underlying
 * error, when any) is for diagnostics and never reaches the client.
 */
export interface AuthFailure {
  readonly status: 400 | 401;
  readonly message: string;
  readonly kind: 'expired' | 'invalid' | 'missing_claim';
  readonly cause?: unknown;
}

/**
 * The surface an app session token is scoped to. Absent = a full web/SPA session (the
 * default). `discord` marks a token minted for the decoupled Discord bridge, which connects
 * to `/ws` **as the real user** — so over `/ws` a Discord token is a normal user connection
 * with the same access as a web session (no per-surface filtering). The claim's only effect
 * is on **HTTP**: the auth guard rejects it (`auth-guard.ts`), keeping a Discord token off
 * the access-token-guarded HTTP routes (the upload sink, admin). It is **not** confined on
 * `/ws`. See `discord-token-mint.ts` and `auth-guard.ts`.
 */
export type AuthSurface = 'discord';

/**
 * The result of authenticating a request: either a resolved identity (the
 * {@link UserClaim} the identity store provisions by, plus an optional display-name
 * seed and an optional {@link AuthSurface} scope) or a typed {@link AuthFailure}.
 * **Total** — `verify` never throws, so the guard has a single `if (!claims.ok)` branch
 * (auth-guard.ts).
 */
export type AuthClaims =
  | {
      readonly ok: true;
      readonly identity: UserClaim;
      readonly seedName?: string;
      readonly surface?: AuthSurface;
    }
  | { readonly ok: false; readonly failure: AuthFailure };

/**
 * Authenticates a request and returns its claims. This is the testability seam
 * (fakes-over-mocks): `GoogleIdTokenVerifier` and `ServiceTokenVerifier` are composed
 * behind a {@link CompositeVerifier} (both schemes live at once), and unit tests inject
 * a fake.
 */
export interface TokenVerifier {
  verify(request: AuthRequest): Promise<AuthClaims>;
}

/** Pull the token out of a `Bearer <token>` Authorization header, or undefined. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return undefined;
  }
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function fail(
  status: 400 | 401,
  kind: AuthFailure['kind'],
  message: string,
  cause?: unknown,
): AuthClaims {
  return {
    ok: false,
    failure: { status, kind, message, ...(cause !== undefined ? { cause } : {}) },
  };
}

/**
 * True when verification failed solely because the token's `exp` has passed.
 * `jose` tags that case with `code: 'ERR_JWT_EXPIRED'`, letting us treat it as
 * expected churn rather than an error worth a full stack trace.
 */
function isExpiredTokenError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'ERR_JWT_EXPIRED';
}

/**
 * Validates Google ID tokens: RS256 signature against Google's JWKS, plus
 * issuer/audience/expiry checks. `jose`'s `createRemoteJWKSet` handles JWKS
 * fetch, caching, and key-rotation cooldown internally.
 *
 * `audience` is the OAuth Web client ID (the SPA and API share it). Google puts
 * `email` / `email_verified` in the ID token by default — no custom claim or
 * Action needed. We require `email_verified === true` before trusting the email.
 * The unverified `name` claim becomes the optional display-name `seedName`.
 */
export class GoogleIdTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
  );

  constructor(private readonly clientId: string) {}

  async verify(request: AuthRequest): Promise<AuthClaims> {
    const token = bearerToken(request.authorization);
    if (!token) {
      return fail(401, 'invalid', 'authentication required');
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.clientId,
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch (error) {
      return isExpiredTokenError(error)
        ? fail(401, 'expired', 'invalid token', error)
        : fail(401, 'invalid', 'invalid token', error);
    }
    if (payload.email_verified !== true || typeof payload.email !== 'string') {
      return fail(401, 'missing_claim', 'token missing verified email');
    }
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    return {
      ok: true,
      identity: { authSource: 'google', email: payload.email },
      ...(name ? { seedName: name } : {}),
    };
  }
}

/** A device-generated user id asserted by a trusted service must be a valid UUID. */
const serviceUserId = z.string().uuid();

/**
 * Server-to-server auth: a trusted backend consumer (e.g.
 * Sprout) calls on behalf of its own anonymous-UUID users. It sends
 * `X-Service-Client-Id: <client_id>`, `Authorization: Bearer <secret>`, and
 * `X-User-Id: <uuid>` (plus optional `X-User-Name`). The (client_id, secret) pair is
 * validated against the `service_registry` (constant-time, per `secret_type`); the
 * user headers are trusted **only** once the credential validates, so an
 * unauthenticated caller cannot spoof a user (architecture.md §8). The acting user is
 * namespaced by `client_id` so two consumers' UUIDs never collide.
 */
export class ServiceTokenVerifier implements TokenVerifier {
  constructor(private readonly registry: ServiceRegistry) {}

  async verify(request: AuthRequest): Promise<AuthClaims> {
    const clientId = request.header('x-service-client-id')?.trim();
    const secret = bearerToken(request.authorization);
    if (!clientId || !secret) {
      return fail(401, 'invalid', 'service authentication required');
    }
    if (!(await this.registry.authenticate(clientId, secret))) {
      return fail(401, 'invalid', 'invalid service credentials');
    }
    const parsed = serviceUserId.safeParse(request.header('x-user-id'));
    if (!parsed.success) {
      return fail(400, 'invalid', 'X-User-Id missing or not a valid UUID');
    }
    const name = request.header('x-user-name')?.trim();
    return {
      ok: true,
      identity: { authSource: 'service', clientId, externalId: parsed.data },
      ...(name ? { seedName: name } : {}),
    };
  }
}

/**
 * Authentication is per-request, not a server-wide mode: both schemes are live at once
 * and a request routes by the credentials it carries. A service consumer self-identifies
 * with `X-Service-Client-Id` — a header no other scheme uses — so its presence routes
 * unambiguously to the service verifier, and we do **not** fall through to the browser
 * scheme on failure (the caller declared intent; falling through would mask a bad service
 * credential as a missing user token). Otherwise the request is a browser bearer, verified
 * by the `browser` verifier — the API's own session access token (session-tokens.ts), which
 * the SPA obtains from `POST /auth/session` after a one-time Google ID-token exchange.
 */
export class CompositeVerifier implements TokenVerifier {
  constructor(
    private readonly browser: TokenVerifier,
    private readonly service: TokenVerifier,
  ) {}

  verify(request: AuthRequest): Promise<AuthClaims> {
    if (request.header('x-service-client-id') !== undefined) {
      return this.service.verify(request);
    }
    return this.browser.verify(request);
  }
}
