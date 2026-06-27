import type { IdentityStore, Logger } from '@cobble/core';
import { decryptSecret, keyFromBase64, secretsEqual, type DiscordConfigStore } from '@cobble/db';
import type { AppConfig } from '../config.js';
import type { AuthRequest, TokenVerifier } from './jwt-verifier.js';
import { mintAccessToken } from './session-tokens.js';

/**
 * The collaborators the Discord token-mint needs, narrowed to exactly what it uses
 * (Interface Segregation): the service-credential verifier, the two stores it reads,
 * the config fields it signs/verifies with (`discordTokenKey` decrypts the stored bot
 * token for the per-user proof check), and a logger. `AppDeps` structurally satisfies
 * this, so the route passes its own `deps` straight through; tests can pass a
 * hand-built object with fakes.
 */
export interface DiscordTokenMintDeps {
  readonly tokenVerifier: TokenVerifier;
  readonly discordConfig: Pick<DiscordConfigStore, 'findByUserId'>;
  readonly identity: Pick<IdentityStore, 'getUserById'>;
  readonly config: Pick<
    AppConfig,
    'discordServiceClientId' | 'jwtSigningSecret' | 'accessTokenTtlSec' | 'discordTokenKey'
  >;
  readonly logger: Logger;
}

/**
 * The outcome of a mint attempt: either the session token to hand back (plus its TTL,
 * for the route to shape into the snake_case envelope) or a typed, HTTP-shaped
 * rejection carrying a client-safe `status` + `error`. **Total** — `mintDiscordToken`
 * never throws for an expected auth/authorization failure, so the route has a single
 * `if (!result.ok)` branch (mirrors the `AuthClaims` convention in jwt-verifier.ts).
 */
export type DiscordTokenMintResult =
  | { readonly ok: true; readonly accessToken: string; readonly expiresInSec: number }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 409; readonly error: string };

const OPERATION = 'discord.mint';

/**
 * Authorize a Discord-worker token-mint request and, if it passes, mint a short-lived
 * **app access token for the real user** (companion-discord.md §9). Framework-free —
 * it takes the Fastify-free {@link AuthRequest} seam and returns a {@link
 * DiscordTokenMintResult}, so the HTTP route stays a thin transport adapter and this
 * orchestration is unit-testable with a plain request object.
 *
 * The gates, in order:
 *  1. Authenticate the caller via the service-credential verifier.
 *  2. Pin to the configured Discord service client — not any service consumer.
 *  3. Authorize: only a user who has opted into Discord (has a `discord_config` row).
 *  4. Prove possession of THAT user's bot token (`X-Discord-Bot-Token`). The service
 *     credential is shared across all users, so `X-User-Id` alone is an unauthenticated
 *     assertion; requiring the user's own bot token — the one secret that identifies
 *     them — means a leaked service credential cannot mint for a user whose bot token it
 *     does not also hold. Without this, any holder of the service secret could mint a
 *     full session for any Discord-enabled user by naming their id.
 *  5. Require an email — the app access token is email-keyed (the session identity).
 */
export async function mintDiscordToken(
  deps: DiscordTokenMintDeps,
  request: AuthRequest,
): Promise<DiscordTokenMintResult> {
  const { config, logger } = deps;

  // 1. Authenticate the caller. The verifier requires a valid `X-Service-Client-Id` +
  //    `Authorization: Bearer <secret>` + a UUID `X-User-Id`.
  const claims = await deps.tokenVerifier.verify(request);
  if (!claims.ok) {
    logger.info('discord token mint rejected: authentication failed', {
      operation: OPERATION,
      kind: claims.failure.kind,
    });
    return { ok: false, status: claims.failure.status, error: claims.failure.message };
  }

  // 2. Pin to the Discord service client specifically — not any service consumer.
  if (
    claims.identity.authSource !== 'service' ||
    claims.identity.clientId !== config.discordServiceClientId
  ) {
    logger.error('discord token mint rejected: not the discord service client', {
      operation: OPERATION,
    });
    return { ok: false, status: 403, error: 'forbidden' };
  }
  // The target user is carried in X-User-Id (the verifier validated it as a UUID).
  const userId = claims.identity.externalId;

  // 3. Authorize: only mint for a user who has opted into Discord.
  const discordConfig = await deps.discordConfig.findByUserId(userId);
  if (!discordConfig) {
    logger.error('discord token mint rejected: user has no discord config', {
      operation: OPERATION,
      userId,
    });
    return { ok: false, status: 403, error: 'user has no discord config' };
  }

  // 4. Prove the caller actually holds THIS user's bot token. X-User-Id is just a
  //    claim the (shared) service credential asserts; the bot token is the per-user
  //    secret that backs it. Mismatch, absence, or an unverifiable stored token all
  //    fail closed with an identical opaque 403 (no oracle distinguishing the cases).
  const presentedBotToken = request.header('x-discord-bot-token');
  if (!presentedBotToken || presentedBotToken.length === 0) {
    logger.error('discord token mint rejected: missing bot-token proof', {
      operation: OPERATION,
      userId,
    });
    return { ok: false, status: 403, error: 'forbidden' };
  }
  let tokenKey: Buffer;
  try {
    tokenKey = keyFromBase64(config.discordTokenKey);
  } catch {
    // Missing/malformed key → the endpoint cannot verify the proof, so it must not mint.
    logger.error('discord token mint rejected: token key missing or malformed', {
      operation: OPERATION,
      userId,
    });
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const decryptedBotToken = decryptSecret(discordConfig.encryptedBotToken, tokenKey);
  if (!decryptedBotToken.ok) {
    logger.error('discord token mint rejected: stored bot token unverifiable', {
      operation: OPERATION,
      userId,
      reason: decryptedBotToken.reason,
    });
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (!secretsEqual(presentedBotToken, decryptedBotToken.plaintext)) {
    logger.error('discord token mint rejected: bot-token proof did not match', {
      operation: OPERATION,
      userId,
    });
    return { ok: false, status: 403, error: 'forbidden' };
  }

  // 5. The app access token is email-keyed (the session identity); a companion-owning
  //    user is a Google user with an email.
  const user = await deps.identity.getUserById(userId);
  if (!user?.email) {
    logger.error('discord token mint failed: user not eligible (no email)', {
      operation: OPERATION,
      userId,
    });
    return { ok: false, status: 409, error: 'user not eligible' };
  }

  const accessToken = mintAccessToken(
    { authSource: 'google', email: user.email },
    config.jwtSigningSecret,
    config.accessTokenTtlSec,
  );
  logger.info('discord token minted', { operation: OPERATION, userId });
  return { ok: true, accessToken, expiresInSec: config.accessTokenTtlSec };
}
