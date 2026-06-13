import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from './app.js';
import type { AuthRequest } from './auth/jwt-verifier.js';

/** A Fastify preHandler that enforces authentication. */
export type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

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
 * Build the auth preHandler. It delegates to the injected verifier (selected by
 * `AUTH_MODE`), which returns a total {@link AuthClaims} result — so the guard is one
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

    const user = await deps.identity.ensureUserByClaim(claims.identity);
    request.userId = user.id;
    // Seed the display name (Google `name` claim, or the `X-User-Name` header) as an
    // `auth_seed` user-fact — only if the user has no name fact yet, so a later request
    // can never resurrect the seed over a name the user has since stated/edited
    // (seedName is idempotent + resurrection-guarded, user-model/store.ts). Best-effort:
    // a seed hiccup must not block the request.
    if (claims.seedName) {
      try {
        await deps.userModel.seedName(user.id, claims.seedName);
      } catch (error) {
        deps.logger.error('failed to seed user name from sign-in', {
          operation: 'auth.seedName',
          error,
        });
      }
    }
  };
}
