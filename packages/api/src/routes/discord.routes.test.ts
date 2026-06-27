import {
  companions,
  DrizzleDiscordConfigStore,
  encryptSecret,
  keyFromBase64,
  serviceRegistry,
  users,
} from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppSessionVerifier } from '../auth/session-tokens.js';
import { makeTestApp, silentLogger, testConfig, type TestApp } from '../test/helpers.js';

const CLIENT_ID = 'discord-adapter';
const SECRET = 'discord-service-secret';
// The owner's real Discord bot token — the per-user secret the worker proves it holds.
const BOT_TOKEN = 'bot-token-aaa';
const tokenKey = keyFromBase64(testConfig.discordTokenKey);

/**
 * Exercises the internal token-mint endpoint end-to-end over a real Fastify app +
 * real ServiceTokenVerifier + PGlite (companion-discord.md §9). The minted token is
 * verified with the real AppSessionVerifier to prove it resolves to the real user.
 */
describe('POST /internal/discord/token', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>['db'];
  let closeDb: () => Promise<void>;
  let test: TestApp;
  let userId: string;

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDatabase());
    // Register the Discord service credential the worker authenticates with.
    await db
      .insert(serviceRegistry)
      .values({ clientId: CLIENT_ID, secret: SECRET, secretType: 'plaintext' });
    // A real user + companion + a discord_config row (the user opted into Discord).
    const [user] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
    userId = user!.id;
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: userId, name: 'Pebble', form: 'fox', temperament: 'curious' })
      .returning();
    await new DrizzleDiscordConfigStore(db).upsert({
      userId,
      encryptedBotToken: encryptSecret(BOT_TOKEN, tokenKey),
      boundCompanionId: companion!.id,
      linkCode: 'CODE1234',
      linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
    });
    test = await makeTestApp(['hi'], silentLogger, {
      config: { discordServiceClientId: CLIENT_ID },
      database: { db, close: closeDb },
    });
  });

  afterEach(async () => {
    await test.close();
    await closeDb();
  });

  function serviceHeaders(
    userIdHeader: string,
    botToken: string = BOT_TOKEN,
  ): Record<string, string> {
    return {
      'x-service-client-id': CLIENT_ID,
      authorization: `Bearer ${SECRET}`,
      'x-user-id': userIdHeader,
      'x-discord-bot-token': botToken,
    };
  }

  it('mints an access token that resolves to the real user', async () => {
    const res = await test.app.inject({
      method: 'POST',
      url: '/internal/discord/token',
      headers: serviceHeaders(userId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string; token_type: string; expires_in: number };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(testConfig.accessTokenTtlSec);

    // The token verifies as the API's own session token and resolves to the real user.
    const verifier = new AppSessionVerifier(testConfig.jwtSigningSecret);
    const claims = await verifier.verify({
      authorization: `Bearer ${body.access_token}`,
      header: () => undefined,
    });
    expect(claims.ok).toBe(true);
    expect(claims.ok && claims.identity).toEqual({
      authSource: 'google',
      email: 'owner@example.com',
    });
  });

  // SECURITY: the endpoint authenticates the *service* (one secret shared across all
  // users), so X-User-Id alone is an unauthenticated claim. These tests pin the per-user
  // binding: the caller must PROVE possession of the named user's bot token. A holder of
  // the service secret therefore cannot impersonate a user whose bot token it lacks.
  describe('per-user bot-token proof', () => {
    const BOT_TOKEN_B = 'bot-token-bbb';
    let userBId: string;

    beforeEach(async () => {
      // A second Discord user B, with their OWN distinct bot token.
      const [userB] = await db.insert(users).values({ email: 'victim-b@example.com' }).returning();
      userBId = userB!.id;
      const [companionB] = await db
        .insert(companions)
        .values({ ownerId: userBId, name: 'Mossy', form: 'cat', temperament: 'aloof' })
        .returning();
      await new DrizzleDiscordConfigStore(db).upsert({
        userId: userBId,
        encryptedBotToken: encryptSecret(BOT_TOKEN_B, tokenKey),
        boundCompanionId: companionB!.id,
        linkCode: 'CODEB000',
        linkCodeIssuedAt: new Date('2026-06-26T12:00:00Z'),
      });
    });

    it('rejects minting for another user with the wrong bot token (403)', async () => {
      // The service credential names B but presents the owner's token, not B's.
      const res = await test.app.inject({
        method: 'POST',
        url: '/internal/discord/token',
        headers: serviceHeaders(userBId, BOT_TOKEN),
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects minting when no bot-token proof is presented (403)', async () => {
      const res = await test.app.inject({
        method: 'POST',
        url: '/internal/discord/token',
        headers: {
          'x-service-client-id': CLIENT_ID,
          authorization: `Bearer ${SECRET}`,
          'x-user-id': userBId,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('mints for the user whose bot token is proven', async () => {
      // Presenting B's actual token authorizes minting for B — the intended semantics.
      const res = await test.app.inject({
        method: 'POST',
        url: '/internal/discord/token',
        headers: serviceHeaders(userBId, BOT_TOKEN_B),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { access_token: string };
      const claims = await new AppSessionVerifier(testConfig.jwtSigningSecret).verify({
        authorization: `Bearer ${body.access_token}`,
        header: () => undefined,
      });
      expect(claims.ok && claims.identity).toEqual({
        authSource: 'google',
        email: 'victim-b@example.com',
      });
    });
  });

  it('rejects a user with no discord_config (403)', async () => {
    const [other] = await db.insert(users).values({ email: 'nodiscord@example.com' }).returning();
    const res = await test.app.inject({
      method: 'POST',
      url: '/internal/discord/token',
      headers: serviceHeaders(other!.id),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects another registered service client (403)', async () => {
    await db
      .insert(serviceRegistry)
      .values({ clientId: 'sprout', secret: 'sprout-secret', secretType: 'plaintext' });
    const res = await test.app.inject({
      method: 'POST',
      url: '/internal/discord/token',
      headers: {
        'x-service-client-id': 'sprout',
        authorization: 'Bearer sprout-secret',
        'x-user-id': userId,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a bad service credential (401)', async () => {
    const res = await test.app.inject({
      method: 'POST',
      url: '/internal/discord/token',
      headers: {
        'x-service-client-id': CLIENT_ID,
        authorization: 'Bearer wrong-secret',
        'x-user-id': userId,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a browser session token, not a service credential (403)', async () => {
    // A real app access token (no X-Service-Client-Id) routes to the browser verifier
    // and authenticates as a user — but it is not the Discord service client.
    const res = await test.app.inject({
      method: 'POST',
      url: '/internal/discord/token',
      headers: test.bearerFor('owner@example.com'),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /internal/discord/token when the Discord surface is disabled', () => {
  it('is not registered (404) without DISCORD_SERVICE_CLIENT_ID', async () => {
    const test = await makeTestApp(['hi'], silentLogger);
    try {
      const res = await test.app.inject({
        method: 'POST',
        url: '/internal/discord/token',
        headers: { 'x-service-client-id': CLIENT_ID, authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await test.close();
    }
  });
});
