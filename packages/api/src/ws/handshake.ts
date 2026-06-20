import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AuthRequest } from '../auth/jwt-verifier.js';

/**
 * Authenticate the WS upgrade ONCE, at the handshake (deliver-scalability.md §5.2):
 * the resolved `userId` is fixed for the connection's life, so per-message auth is
 * unnecessary. Mirrors the HTTP guard (makeRequireAuth) but also accepts the bearer
 * as an `access_token` query param — a browser's `WebSocket` cannot set an
 * Authorization header, while service clients still send their headers. Run as a
 * preValidation: a sent reply aborts the upgrade, so a bad token never opens a socket.
 */
function toWsAuthRequest(request: FastifyRequest): AuthRequest {
  const headerAuth = request.headers.authorization;
  const query = request.query as { access_token?: string } | undefined;
  const queryToken = typeof query?.access_token === 'string' ? query.access_token : undefined;
  const authorization =
    typeof headerAuth === 'string' ? headerAuth : queryToken ? `Bearer ${queryToken}` : undefined;
  return {
    authorization,
    header(name: string): string | undefined {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

export function makeWsAuth(
  deps: AppDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function wsAuth(request, reply): Promise<void> {
    // Cross-site WebSocket hijacking defense: @fastify/cors does not run on the
    // upgrade, so pin the handshake to the configured app origin here. A browser
    // always sends `Origin` on a WS upgrade — reject any that isn't our app before
    // doing auth work. A non-browser service client sends no `Origin` (and proves
    // itself with a bearer header), so absence is allowed. Defense-in-depth today
    // since the bearer is non-ambient; load-bearing the moment it ever becomes so.
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== deps.config.appUrl) {
      deps.logger.error('ws upgrade rejected: origin not allowed', {
        operation: 'ws.auth',
        origin,
      });
      await reply.code(403).send({ error: 'origin not allowed' });
      return;
    }
    const claims = await deps.tokenVerifier.verify(toWsAuthRequest(request));
    if (!claims.ok) {
      const { status, message, kind, cause } = claims.failure;
      if (kind === 'expired') {
        deps.logger.info('ws token expired; re-authentication required', { operation: 'ws.auth' });
      } else {
        deps.logger.error('ws authentication rejected', {
          operation: 'ws.auth',
          kind,
          error: cause,
        });
      }
      await reply.code(status).send({ error: message });
      return;
    }
    const user = await deps.identity.ensureUserByClaim(claims.identity);
    request.userId = user.id;
    if (claims.seedName) {
      try {
        await deps.userModel.seedName(user.id, claims.seedName);
      } catch (error) {
        deps.logger.error('failed to seed user name from ws sign-in', {
          operation: 'ws.auth.seedName',
          error,
        });
      }
    }
    // A connection that names a companion embodies it (Phase D D2). Resolve +
    // ownership-check here, at the handshake, so an unauthorized companion never
    // opens a socket. A connection with no `companion` param is transport-only.
    const query = request.query as { companion?: string } | undefined;
    const companionId = typeof query?.companion === 'string' ? query.companion : undefined;
    if (companionId) {
      const companion = await deps.identity.getCompanion(companionId, user.id);
      if (!companion) {
        await reply.code(404).send({ error: 'companion not found' });
        return;
      }
      request.companionId = companion.id;
    }
  };
}
