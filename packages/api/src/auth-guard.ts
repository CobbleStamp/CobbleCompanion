import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from './app.js';

/** A Fastify preHandler that enforces authentication. */
export type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

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
      deps.logger.error('token verification failed', { operation: 'auth.verify', error });
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
