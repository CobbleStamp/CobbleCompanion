/**
 * API entrypoint: loads config, wires the production dependency graph (stores,
 * gateways, ingestion pipeline + runner, harness with semantic recall), and
 * starts the Fastify server.
 */

import { createPgDatabase, EMBEDDING_DIMENSIONS } from '@cobble/db';
import {
  consoleLogger,
  createHttpLinkResolver,
  createSemanticRetrieveContext,
  createSourceParser,
  DrizzleIdentityStore,
  DrizzleSemanticMemoryStore,
  DrizzleTokenQuotaStore,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  Harness,
  IngestionPipeline,
  IngestionRunner,
  LlmIngestionAnnouncer,
  OpenRouterEmbeddingGateway,
  OpenRouterGateway,
  resumeDeferredJobs,
  TranscriptMemoryStore,
  type EmbeddingGateway,
  type LlmGateway,
} from '@cobble/core';
import { buildApp } from './app.js';
import {
  DevBypassVerifier,
  GoogleIdTokenVerifier,
  type TokenVerifier,
} from './auth/jwt-verifier.js';
import { loadConfig, type AppConfig } from './config.js';

function createGateway(config: AppConfig): LlmGateway {
  if (config.llmProvider === 'fake') {
    return new FakeLlmGateway();
  }
  return new OpenRouterGateway({ apiKey: config.openrouterApiKey });
}

function createEmbeddingGateway(config: AppConfig): EmbeddingGateway {
  if (config.embeddingProvider === 'fake') {
    return new FakeEmbeddingGateway();
  }
  return new OpenRouterEmbeddingGateway({ apiKey: config.openrouterApiKey });
}

function createTokenVerifier(config: AppConfig): TokenVerifier {
  if (config.authMode === 'dev_bypass') {
    return new DevBypassVerifier(config.devBypassEmail);
  }
  return new GoogleIdTokenVerifier(config.googleClientId);
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.embeddingDimensions !== EMBEDDING_DIMENSIONS) {
    // Fail fast: the vector column dimension is fixed by migration.
    throw new Error(
      `EMBEDDING_DIM=${config.embeddingDimensions} does not match the schema's vector(${EMBEDDING_DIMENSIONS}) column`,
    );
  }
  const { db } = createPgDatabase(config.databaseUrl);

  const identity = new DrizzleIdentityStore(db);
  const memory = new TranscriptMemoryStore(db);
  const semantic = new DrizzleSemanticMemoryStore(db);
  const quota = new DrizzleTokenQuotaStore(db, { defaultCapTokens: config.tokenCapPerDay });
  const llmGateway = createGateway(config);
  const embeddings = createEmbeddingGateway(config);

  const ingestion = new IngestionRunner(
    new IngestionPipeline({
      semantic,
      llm: llmGateway,
      embeddings,
      ingestionModel: config.ingestionModel,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      useContextHeader: config.useContextHeader,
      sourceParser: createSourceParser({
        linkResolver: createHttpLinkResolver({ maxBytes: config.ingestionMaxBytes }),
      }),
      quota,
      logger: consoleLogger,
      announcer: new LlmIngestionAnnouncer({
        identity,
        memory,
        llm: llmGateway,
        model: config.ingestionModel,
        quota,
        logger: consoleLogger,
      }),
    }),
    consoleLogger,
    config.ingestionQueueMax,
  );

  const harness = new Harness({
    gateway: llmGateway,
    memory,
    model: config.llmModel,
    quota,
    logger: consoleLogger,
    retrieveContext: createSemanticRetrieveContext({
      memory,
      semantic,
      embeddings,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      logger: consoleLogger,
    }),
  });

  const app = await buildApp({
    identity,
    memory,
    semantic,
    embeddings,
    ingestion,
    harness,
    quota,
    tokenVerifier: createTokenVerifier(config),
    config,
    logger: consoleLogger,
  });

  // Restart recovery: jobs interrupted mid-run lost their in-memory state, so
  // fail them (the user re-uploads); deferred jobs kept their parse and resume.
  const failed = await semantic.failInterruptedJobs();
  if (failed > 0) {
    consoleLogger.info('failed interrupted ingestion jobs on startup', { count: failed });
  }

  // Resume parked (deferred) jobs now and on a timer, so work that hit yesterday's
  // cap drains as allowances reset (architecture.md §4.8). Serial + cap-gated, so
  // it never overspends.
  const sweepDeps = { semantic, quota, ingestion, logger: consoleLogger };
  await resumeDeferredJobs(sweepDeps);
  const sweepTimer = setInterval(() => {
    void resumeDeferredJobs(sweepDeps).catch((error: unknown) => {
      consoleLogger.error('deferred-job sweep failed', { error });
    });
  }, DEFERRED_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  consoleLogger.info('api listening', { port: config.port });
}

/** How often to resume deferred ingestion jobs (cheap; just a status scan). */
const DEFERRED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

main().catch((error: unknown) => {
  consoleLogger.error('api failed to start', { error });
  process.exitCode = 1;
});
