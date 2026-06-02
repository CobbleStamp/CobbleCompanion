import { createPgDatabase } from '@cobble/db';
import {
  consoleLogger,
  DrizzleIdentityStore,
  FakeLlmGateway,
  Harness,
  OpenRouterGateway,
  TranscriptMemoryStore,
  type LlmGateway,
} from '@cobble/core';
import { buildApp } from './app.js';
import { Auth0TokenVerifier, DevBypassVerifier, type TokenVerifier } from './auth/jwt-verifier.js';
import { loadConfig, type AppConfig } from './config.js';

function createGateway(config: AppConfig): LlmGateway {
  if (config.llmProvider === 'fake') {
    return new FakeLlmGateway();
  }
  return new OpenRouterGateway({ apiKey: config.openrouterApiKey });
}

function createTokenVerifier(config: AppConfig): TokenVerifier {
  if (config.authMode === 'dev_bypass') {
    return new DevBypassVerifier(config.devBypassEmail);
  }
  return new Auth0TokenVerifier(config.auth0Domain, config.auth0Audience);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { db } = createPgDatabase(config.databaseUrl);

  const identity = new DrizzleIdentityStore(db);
  const memory = new TranscriptMemoryStore(db);
  const harness = new Harness({
    gateway: createGateway(config),
    memory,
    model: config.llmModel,
    logger: consoleLogger,
  });

  const app = await buildApp({
    identity,
    memory,
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
