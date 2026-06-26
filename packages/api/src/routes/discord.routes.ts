import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AuthRequest } from '../auth/jwt-verifier.js';
import { mintAccessToken } from '../auth/session-tokens.js';

/**
 * The internal token-mint endpoint for the Discord adapter (companion-discord.md §9,
 * plans/discord-surface.md §11 — the "connect as the real user" decision).
 *
 * The decoupled Discord worker can't reach `/ws` as a service consumer — that would
 * namespace it as a *separate* user that doesn't own the companion. Instead it asks
 * this endpoint for a short-lived **app access token for the real user**, then connects
 * to `/ws` exactly like the web client. The signing secret (`jwtSigningSecret`) stays in
 * the API and is never held by the worker.
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

  app.post('/internal/discord/token', async (request, reply) => {
    // 1. Authenticate the caller. The ServiceTokenVerifier requires a valid
    //    `X-Service-Client-Id` + `Authorization: Bearer <secret>` + a UUID `X-User-Id`.
    const claims = await deps.tokenVerifier.verify(toAuthRequest(request));
    if (!claims.ok) {
      deps.logger.info('discord token mint rejected: authentication failed', {
        operation: 'discord.mint',
        kind: claims.failure.kind,
      });
      return reply.code(claims.failure.status).send({ error: claims.failure.message });
    }
    // 2. Pin to the Discord service client specifically — not any service consumer.
    if (
      claims.identity.authSource !== 'service' ||
      claims.identity.clientId !== config.discordServiceClientId
    ) {
      deps.logger.error('discord token mint rejected: not the discord service client', {
        operation: 'discord.mint',
      });
      return reply.code(403).send({ error: 'forbidden' });
    }
    // The target user is carried in X-User-Id (the verifier validated it as a UUID).
    const userId = claims.identity.externalId;

    // 3. Authorize: only mint for a user who has opted into Discord.
    const discordConfig = await deps.discordConfig.findByUserId(userId);
    if (!discordConfig) {
      deps.logger.error('discord token mint rejected: user has no discord config', {
        operation: 'discord.mint',
        userId,
      });
      return reply.code(403).send({ error: 'user has no discord config' });
    }

    // 4. The app access token is email-keyed (the session identity); a companion-owning
    //    user is a Google user with an email.
    const user = await deps.identity.getUserById(userId);
    if (!user?.email) {
      deps.logger.error('discord token mint failed: user not eligible (no email)', {
        operation: 'discord.mint',
        userId,
      });
      return reply.code(409).send({ error: 'user not eligible' });
    }

    const accessToken = mintAccessToken(
      { authSource: 'google', email: user.email },
      config.jwtSigningSecret,
      config.accessTokenTtlSec,
    );
    deps.logger.info('discord token minted', { operation: 'discord.mint', userId });
    // snake_case envelope, matching /auth/session.
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSec,
    };
  });
}
