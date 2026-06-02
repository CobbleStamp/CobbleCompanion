import { createPgDatabase } from '@cobble/db';
import {
  consoleLogger,
  DrizzleAuthTokenStore,
  DrizzleIdentityStore,
  FakeLlmGateway,
  Harness,
  OpenRouterGateway,
  TranscriptMemoryStore,
  type LlmGateway,
} from '@cobble/core';
import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { ConsoleEmailSender } from './email.js';

function createGateway(config: AppConfig): LlmGateway {
  if (config.llmProvider === 'fake') {
    return new FakeLlmGateway();
  }
  return new OpenRouterGateway({ apiKey: config.openrouterApiKey });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { db } = createPgDatabase(config.databaseUrl);

  const identity = new DrizzleIdentityStore(db);
  const authTokens = new DrizzleAuthTokenStore(db);
  const memory = new TranscriptMemoryStore(db);
  const harness = new Harness({
    gateway: createGateway(config),
    memory,
    model: config.llmModel,
    logger: consoleLogger,
  });
  const email = new ConsoleEmailSender(consoleLogger);

  const app = await buildApp({
    identity,
    authTokens,
    memory,
    harness,
    email,
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
