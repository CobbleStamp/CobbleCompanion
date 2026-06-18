import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

/**
 * Public SPA auth bootstrap. This is the one HTTP `/auth` route: the web client
 * fetches it *before* it can authenticate (to learn the Google client id), so it
 * can't ride the authenticated WS handshake. Identity-of-the-signed-in-user is the
 * WS `auth.me` method (the handshake authenticates the connection).
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
}
