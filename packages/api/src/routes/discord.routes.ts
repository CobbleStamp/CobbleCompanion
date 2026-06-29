import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AuthRequest } from '../auth/jwt-verifier.js';
import { mintDiscordToken } from '../auth/discord-token-mint.js';

/**
 * The internal token-mint endpoint for the Discord adapter (companion-discord.md §9,
 * plans/discord-surface.md §11 — the "connect as the real user" decision).
 *
 * The decoupled Discord service can't reach `/ws` as a service consumer — that would
 * namespace it as a *separate* user that doesn't own the companion. Instead it asks
 * this endpoint for a short-lived **app access token for the real user**, then connects
 * to `/ws` exactly like the web client. The signing secret (`jwtSigningSecret`) stays in
 * the API and is never held by the service.
 *
 * Auth: the caller authenticates with the Discord **service credential** (the existing
 * `ServiceTokenVerifier` / `service_registry`), naming the target user via `X-User-Id`.
 * The route mints **only** for (a) the configured Discord service client and (b) a user
 * that has a `discord_config` row — so a service credential cannot mint tokens for
 * arbitrary users, and no other service consumer can use it at all.
 *
 * Disabled (not registered) unless `DISCORD_SERVICE_CLIENT_ID` is set.
 */

function toAuthRequest(request: FastifyRequest): AuthRequest {
  const headerAuth = request.headers.authorization;
  return {
    authorization: typeof headerAuth === 'string' ? headerAuth : undefined,
    header(name: string): string | undefined {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

export function registerDiscordRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config } = deps;
  // Off until an operator both registers the service client and names it here.
  if (config.discordServiceClientId.length === 0) {
    return;
  }

  // Thin transport adapter: adapt the request to the framework-free `AuthRequest`
  // seam, delegate the authorize-and-mint decision to `mintDiscordToken`, then map
  // its typed result to an HTTP reply. All the gating logic + logging lives in the
  // module (auth/discord-token-mint.ts).
  app.post('/internal/discord/token', async (request, reply) => {
    const result = await mintDiscordToken(deps, toAuthRequest(request));
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    // snake_case envelope, matching /auth/session.
    return {
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresInSec,
    };
  });
}
