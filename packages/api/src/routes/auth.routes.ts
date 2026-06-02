import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RequireAuth } from '../auth-guard.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  requireAuth: RequireAuth,
): void {
  const { identity, config } = deps;

  // Public SPA bootstrap. The web client fetches this before deciding which
  // provider tree to mount, so a single bundle targets any environment.
  // snake_case to match the web parser (packages/web/src/auth/config.ts).
  app.get('/auth/config', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return {
      mode: config.authMode,
      auth0_domain: config.auth0Domain,
      auth0_client_id: config.auth0ClientId,
      auth0_audience: config.auth0Audience,
    };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await identity.getUserById(request.userId!);
    if (!user) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    return reply.send({ user: { id: user.id, email: user.email } });
  });
}
