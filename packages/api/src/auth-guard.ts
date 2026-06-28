import type { UserClaim, UserRecord } from '@cobble/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { redactUrl, type AppDeps } from './app.js';
import type { AuthRequest } from './auth/jwt-verifier.js';

/** A Fastify preHandler that enforces authentication. */
export type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * JIT-provision the user named by an authenticated claim and best-effort seed their
 * display name. Shared by the per-request guard and the `POST /auth/session` exchange
 * so provisioning behaves identically however a user first arrives. The name seed
 * (Google `name` claim, or `X-User-Name`) is written only if the user has no name
 * fact yet, so a later sign-in can never resurrect the seed over a name the user has
 * since stated/edited (seedName is idempotent + resurrection-guarded). Best-effort: a
 * seed hiccup must not block the request.
 */
export async function provisionUser(
  deps: AppDeps,
  identity: UserClaim,
  seedName: string | undefined,
): Promise<UserRecord> {
  const user = await deps.identity.ensureUserByClaim(identity);
  if (seedName) {
    try {
      await deps.userModel.seedName(user.id, seedName);
    } catch (error) {
      deps.logger.error('failed to seed user name from sign-in', {
        operation: 'auth.seedName',
        error,
      });
    }
  }
  return user;
}

/** Adapt a `FastifyRequest` to the framework-free {@link AuthRequest} the verifier sees. */
function toAuthRequest(request: FastifyRequest): AuthRequest {
  const authorization = request.headers.authorization;
  return {
    authorization: typeof authorization === 'string' ? authorization : undefined,
    header(name: string): string | undefined {
      // Fastify lowercases header keys; a repeated header arrives as an array.
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

/**
 * Build the auth preHandler. It delegates to the injected verifier (the composite
 * that routes per request), which returns a total {@link AuthClaims} result — so the guard is one
 * generic branch with no try/catch. On success it JIT-provisions the user from the
 * verifier's claim and sets `request.userId` for tenancy scoping (architecture.md §8:
 * authorization at the API boundary before the core).
 */
export function makeRequireAuth(deps: AppDeps): RequireAuth {
  return async function requireAuth(request, reply) {
    const claims = await deps.tokenVerifier.verify(toAuthRequest(request));
    if (!claims.ok) {
      const { status, message, kind, cause } = claims.failure;
      // An expired token is a routine client condition, not a server fault: the caller
      // simply needs to re-authenticate. Log it at info (no stack) so it doesn't drown
      // the error stream; reserve error for genuine anomalies (bad signature, wrong
      // audience, missing/invalid claims, bad service token).
      if (kind === 'expired') {
        deps.logger.info('token expired; re-authentication required', { operation: 'auth.verify' });
      } else {
        deps.logger.error('authentication rejected', {
          operation: 'auth.verify',
          kind,
          error: cause,
        });
      }
      await reply.code(status).send({ error: message });
      return;
    }

    // The Discord bridge connects to `/ws` as the real user, so over `/ws` a discord token
    // is a normal user connection (full access — not confined). The `surface` claim only
    // gates HTTP: reject it here on every access-token-guarded route, keeping a Discord token
    // off the HTTP API. `/ws` has its own handshake (handshake.ts) and is unaffected.
    if (claims.surface === 'discord') {
      deps.logger.error('http request rejected: discord-surface token not valid here', {
        operation: 'auth.verify',
        url: redactUrl(request.url),
      });
      await reply.code(403).send({ error: 'forbidden' });
      return;
    }

    const user = await provisionUser(deps, claims.identity, claims.seedName);
    request.userId = user.id;
  };
}

/**
 * A preHandler that admits only operator (admin) users — gates the admin-only
 * surface (the `/admin/queue` observability read, deliver-scalability.md §C).
 * Runs **after** {@link makeRequireAuth} in the chain, so `request.userId` is set;
 * it loads the user and rejects a non-admin with 403. A missing userId (guard
 * mis-ordered) or unknown user is treated as non-admin — fail closed.
 */
export function makeRequireAdmin(deps: AppDeps): RequireAuth {
  return async function requireAdmin(request, reply) {
    const userId = request.userId;
    const user = userId ? await deps.identity.getUserById(userId) : null;
    if (!user?.isAdmin) {
      deps.logger.info('admin access denied', {
        operation: 'auth.requireAdmin',
        userId,
        url: redactUrl(request.url),
      });
      await reply.code(403).send({ error: 'forbidden' });
      return;
    }
  };
}
