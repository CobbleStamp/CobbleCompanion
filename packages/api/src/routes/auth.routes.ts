import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { provisionUser } from '../auth-guard.js';
import type { SessionIdentity } from '../auth/session-tokens.js';
import { mintAccessToken, mintRefreshToken, verifyRefreshToken } from '../auth/session-tokens.js';

/** The HttpOnly cookie carrying the refresh token. Scoped to `/auth` so it rides only
 *  the refresh/logout/session calls, never the WS handshake or any other route. */
const REFRESH_COOKIE = 'cobble.refresh';
const REFRESH_COOKIE_PATH = '/auth';

/**
 * Cookie attributes for the refresh token. `HttpOnly` keeps it out of JS (XSS can't
 * read it); it is a **session cookie** (no `maxAge`/`expires`) so it clears on browser
 * close — matching the prior `sessionStorage` posture — with the refresh token's own
 * `exp` as the hard cap. In production the SPA is served same-origin, so `SameSite=Lax`
 * suffices; in dev the SPA (`:3001`) calls the API (`:3000`) cross-origin, which needs
 * `SameSite=None; Secure`. `Secure` is set in both cases — `SameSite=None` *requires*
 * it, and browsers treat `localhost` as a secure context so a `Secure` cookie is still
 * accepted over http://localhost. Consequence: cross-origin dev must be reached via
 * `localhost`/`127.0.0.1` (or https); a plain-http non-loopback dev host (e.g. a LAN IP)
 * silently drops the cookie and the session won't persist.
 */
function refreshCookieOptions(deps: AppDeps): CookieSerializeOptions {
  const crossOrigin = !deps.config.isProduction;
  return {
    httpOnly: true,
    secure: true,
    sameSite: crossOrigin ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * CSRF defense for the cookie-bearing `/auth` POST routes. These mutate session state
 * from a credential the browser attaches ambiently (the refresh cookie) or that the
 * SPA holds, so a cross-site page could otherwise drive them. Pin the request to the
 * configured app origin — the same rule the WS handshake applies (ws/handshake.ts): a
 * browser always sends `Origin` on these cross-origin/fetch POSTs, so a mismatched one
 * is rejected; a non-browser caller (e.g. an integration test via `inject`) sends none,
 * which is allowed (these routes are not a service-token surface). On reply-sent the
 * handler must return so the route body doesn't also run.
 */
function rejectForeignOrigin(request: FastifyRequest, reply: FastifyReply, deps: AppDeps): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== deps.config.appUrl) {
    deps.logger.error('auth route rejected: origin not allowed', {
      operation: 'auth.origin',
      origin,
    });
    void reply.code(403).send({ error: 'origin not allowed' });
    return true;
  }
  return false;
}

/** Mint a fresh access + refresh pair for `identity`, set the refresh cookie, and
 *  return the access-token envelope. Shared by the session and refresh routes. */
function issueSession(deps: AppDeps, reply: FastifyReply, identity: SessionIdentity): unknown {
  const { jwtSigningSecret, accessTokenTtlSec, refreshTokenTtlSec } = deps.config;
  const accessToken = mintAccessToken(identity, jwtSigningSecret, accessTokenTtlSec);
  const refreshToken = mintRefreshToken(identity, jwtSigningSecret, refreshTokenTtlSec);
  reply.setCookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(deps));
  // snake_case envelope (OAuth-style), matching the /auth/config convention.
  return { access_token: accessToken, token_type: 'Bearer', expires_in: accessTokenTtlSec };
}

/**
 * The HTTP `/auth` surface: a public config bootstrap plus the app-managed session
 * exchange (implementation.md §5). The browser obtains a Google ID token, exchanges
 * it **once** at `POST /auth/session` for the API's own short-lived access token
 * (returned in the body) and a refresh token (set as an HttpOnly cookie), then
 * refreshes silently against `POST /auth/refresh` until that cookie expires. All
 * other requests — including the WS handshake — carry the app access token, not the
 * Google token. `POST /auth/logout` clears the cookie.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config } = deps;

  // snake_case to match the web parser (packages/web/src/auth/config.ts).
  app.get('/auth/config', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    // The browser signs in with Google; service-token auth is a backend concern the
    // SPA never sees. The client only needs the public OAuth client id.
    return {
      google_client_id: config.googleClientId,
    };
  });

  // Exchange a Google ID token (sent as the Authorization bearer) for an app session.
  app.post('/auth/session', async (request, reply) => {
    if (rejectForeignOrigin(request, reply, deps)) return reply;
    const authorization = request.headers.authorization;
    const claims = await deps.googleVerifier.verify({
      authorization: typeof authorization === 'string' ? authorization : undefined,
      header: () => undefined,
    });
    if (!claims.ok) {
      const { status, message, kind, cause } = claims.failure;
      if (kind === 'expired') {
        deps.logger.info('google id token expired at /auth/session', { operation: 'auth.session' });
      } else {
        deps.logger.error('google id token rejected at /auth/session', {
          operation: 'auth.session',
          kind,
          error: cause,
        });
      }
      return reply.code(status).send({ error: message });
    }
    // The Google verifier only ever yields a google identity; guard defensively.
    if (claims.identity.authSource !== 'google') {
      return reply.code(401).send({ error: 'invalid token' });
    }
    const identity: SessionIdentity = claims.identity;
    await provisionUser(deps, identity, claims.seedName);
    return issueSession(deps, reply, identity);
  });

  // Mint a new access token from the refresh cookie (no Google round-trip). The
  // cookie is re-issued to slide the session window.
  app.post('/auth/refresh', async (request, reply) => {
    if (rejectForeignOrigin(request, reply, deps)) return reply;
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: 'no session' });
    }
    const verified = verifyRefreshToken(token, config.jwtSigningSecret);
    if (!verified.ok) {
      // Expired/invalid refresh token: clear the stale cookie so the browser stops
      // re-sending it, and make the client re-authenticate.
      reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      deps.logger.info('refresh token rejected; re-authentication required', {
        operation: 'auth.refresh',
      });
      return reply.code(401).send({ error: 'session expired' });
    }
    return issueSession(deps, reply, verified.identity);
  });

  // Drop the session: clear the refresh cookie. (Stateless tokens have no server-side
  // revocation; the short-lived access token simply lapses — see session-tokens.ts.)
  app.post('/auth/logout', async (request, reply) => {
    if (rejectForeignOrigin(request, reply, deps)) return reply;
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return reply.code(204).send();
  });
}
