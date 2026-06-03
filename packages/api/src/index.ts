/**
 * API entrypoint: loads config, wires the production dependency graph (stores,
 * gateways, ingestion pipeline + runner, harness with semantic recall), and
 * starts the Fastify server.
 */

import { createPgDatabase, EMBEDDING_DIMENSIONS } from '@cobble/db';
import {
  consoleLogger,
  createSemanticRetrieveContext,
  DrizzleIdentityStore,
  DrizzleSemanticMemoryStore,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  Harness,
  IngestionPipeline,
  IngestionRunner,
  OpenRouterEmbeddingGateway,
  OpenRouterGateway,
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
      logger: consoleLogger,
    }),
    consoleLogger,
  );

  const harness = new Harness({
    gateway: llmGateway,
    memory,
    model: config.llmModel,
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
    tokenVerifier: createTokenVerifier(config),
    config,
    logger: consoleLogger,
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  consoleLogger.info('api listening', { port: config.port });
}

main().catch((error: unknown) => {
  consoleLogger.error('api failed to start', { error });
  process.exitCode = 1;
});
