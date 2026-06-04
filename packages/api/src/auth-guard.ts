import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from './app.js';

/** A Fastify preHandler that enforces authentication. */
export type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * True when verification failed solely because the token's `exp` has passed.
 * `jose` tags that case with `code: 'ERR_JWT_EXPIRED'`, letting us treat it as
 * expected churn rather than an error worth a full stack trace.
 */
function isExpiredTokenError(error: unknown): boolean {
  return (
    error instanceof Error && (error as { code?: unknown }).code === 'ERR_JWT_EXPIRED'
  );
}

/**
 * Build the auth preHandler. It validates the `Authorization: Bearer <token>`
 * header against the injected verifier, then JIT-provisions the user by the
 * token's email claim and sets `request.userId` for tenancy scoping
 * (architecture.md §8: authorization at the API boundary before the core).
 */
export function makeRequireAuth(deps: AppDeps): RequireAuth {
  return async function requireAuth(request, reply) {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      await reply.code(401).send({ error: 'authentication required' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();

    let email: string | undefined;
    try {
      const claims = await deps.tokenVerifier.verify(token);
      email = claims.email;
    } catch (error) {
      // An expired token is a routine client condition, not a server fault: the
      // browser simply needs to re-authenticate. Log it at info (no stack) so it
      // doesn't drown the error stream; reserve error for genuine anomalies
      // (bad signature, wrong audience, missing claims).
      if (isExpiredTokenError(error)) {
        deps.logger.info('token expired; re-authentication required', {
          operation: 'auth.verify',
        });
      } else {
        deps.logger.error('token verification failed', { operation: 'auth.verify', error });
      }
      await reply.code(401).send({ error: 'invalid token' });
      return;
    }
    if (!email) {
      await reply.code(401).send({ error: 'token missing email claim' });
      return;
    }

    const user = await deps.identity.ensureUserByEmail(email);
    request.userId = user.id;
  };
}
