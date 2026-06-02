import { createTestDatabase } from '@cobble/db/testing';
import {
  DrizzleIdentityStore,
  FakeLlmGateway,
  Harness,
  TranscriptMemoryStore,
  type Logger,
} from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../app.js';
import type { TokenVerifier, VerifiedClaims } from '../auth/jwt-verifier.js';
import type { AppConfig } from '../config.js';

export const silentLogger: Logger = { error: () => {}, info: () => {} };

/**
 * Token verifier for tests: maps a known token string to claims, throwing on
 * anything unregistered. Lets tests exercise the auth boundary without signing
 * real RS256 tokens or touching JWKS (fakes-over-mocks).
 */
export class FakeTokenVerifier implements TokenVerifier {
  private readonly byToken = new Map<string, VerifiedClaims>();

  set(token: string, claims: VerifiedClaims): void {
    this.byToken.set(token, claims);
  }

  async verify(token: string): Promise<VerifiedClaims> {
    const claims = this.byToken.get(token);
    if (!claims) {
      throw new Error('unknown test token');
    }
    return claims;
  }
}

export const testConfig: AppConfig = {
  databaseUrl: 'unused-in-tests',
  llmProvider: 'fake',
  openrouterApiKey: '',
  llmModel: 'test-model',
  appUrl: 'http://localhost:3001',
  authMode: 'auth0',
  auth0Domain: 'test.auth0.local',
  auth0ClientId: 'test-client-id',
  auth0Audience: 'https://api.cobble.test',
  devBypassEmail: 'dev@cobble.local',
  port: 0,
  isProduction: false,
};

export interface TestApp {
  readonly app: FastifyInstance;
  readonly deps: AppDeps;
  readonly tokenVerifier: FakeTokenVerifier;
  /** Build the Authorization headers for `address`, registering its fake token. */
  readonly bearerFor: (address: string) => { authorization: string };
  readonly close: () => Promise<void>;
}

export async function makeTestApp(chunks: readonly string[] = ['Hi', ' there']): Promise<TestApp> {
  const { db, close: closeDb } = await createTestDatabase();
  const memory = new TranscriptMemoryStore(db);
  const tokenVerifier = new FakeTokenVerifier();
  const deps: AppDeps = {
    identity: new DrizzleIdentityStore(db),
    memory,
    harness: new Harness({
      gateway: new FakeLlmGateway(chunks),
      memory,
      model: 'test-model',
      logger: silentLogger,
    }),
    tokenVerifier,
    config: testConfig,
    logger: silentLogger,
  };
  const app = await buildApp(deps);
  await app.ready();

  const bearerFor = (address: string): { authorization: string } => {
    const token = `test-${address}`;
    tokenVerifier.set(token, { sub: `auth0|${address}`, email: address });
    return { authorization: `Bearer ${token}` };
  };

  return {
    app,
    deps,
    tokenVerifier,
    bearerFor,
    close: async () => {
      await app.close();
      await closeDb();
    },
  };
}
