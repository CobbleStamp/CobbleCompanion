/**
 * Shared API test harness: builds the real Fastify app over an in-memory
 * PGlite database with fake gateways (fakes-over-mocks) and a fake token
 * verifier, so route tests exercise the true auth → route → core → db path.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import {
  createSemanticRetrieveContext,
  DrizzleIdentityStore,
  DrizzleSemanticMemoryStore,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  Harness,
  IngestionPipeline,
  IngestionRunner,
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
  embeddingProvider: 'fake',
  embeddingModel: 'fake-embed',
  embeddingDimensions: EMBEDDING_DIMENSIONS,
  ingestionModel: 'test-ingestion-model',
  ingestionMaxBytes: 25 * 1024 * 1024,
  useContextHeader: true,
  rateLimitWindowMs: 60 * 1000,
  ingestionRateMax: 10,
  searchRateMax: 30,
  ingestionQueueMax: 100,
  appUrl: 'http://localhost:3001',
  authMode: 'google',
  googleClientId: 'test-google-client-id',
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

/** Overrides for tests exercising config-driven behavior (limits, queue cap). */
export interface TestAppOptions {
  readonly config?: Partial<AppConfig>;
  /** Replace the runner entirely (fault injection, e.g. a queue-full race). */
  readonly ingestion?: IngestionRunner;
}

export async function makeTestApp(
  chunks: readonly string[] = ['Hi', ' there'],
  logger: Logger = silentLogger,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const config: AppConfig = { ...testConfig, ...options.config };
  const { db, close: closeDb } = await createTestDatabase();
  const memory = new TranscriptMemoryStore(db);
  const semantic = new DrizzleSemanticMemoryStore(db);
  const embeddings = new FakeEmbeddingGateway();
  const llmGateway = new FakeLlmGateway(chunks);
  const tokenVerifier = new FakeTokenVerifier();
  // Queue cap comes from config, mirroring production wiring (index.ts).
  const ingestion =
    options.ingestion ??
    new IngestionRunner(
      new IngestionPipeline({
        semantic,
        llm: llmGateway,
        embeddings,
        ingestionModel: config.ingestionModel,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        useContextHeader: config.useContextHeader,
        logger: silentLogger,
      }),
      silentLogger,
      config.ingestionQueueMax,
    );
  const deps: AppDeps = {
    identity: new DrizzleIdentityStore(db),
    memory,
    semantic,
    embeddings,
    ingestion,
    harness: new Harness({
      gateway: llmGateway,
      memory,
      model: 'test-model',
      logger: silentLogger,
      retrieveContext: createSemanticRetrieveContext({
        memory,
        semantic,
        embeddings,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        logger: silentLogger,
      }),
    }),
    tokenVerifier,
    config,
    logger,
  };
  const app = await buildApp(deps);
  await app.ready();

  const bearerFor = (address: string): { authorization: string } => {
    const token = `test-${address}`;
    tokenVerifier.set(token, { sub: `google|${address}`, email: address });
    return { authorization: `Bearer ${token}` };
  };

  return {
    app,
    deps,
    tokenVerifier,
    bearerFor,
    close: async () => {
      await ingestion.whenIdle();
      await app.close();
      await closeDb();
    },
  };
}
