/**
 * Shared API test harness: builds the real Fastify app over an in-memory
 * PGlite database with fake gateways (fakes-over-mocks) and a fake token
 * verifier, so route tests exercise the true auth → route → core → db path.
 */

import { EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import {
  composeRetrieveContext,
  ConsolidationRunner,
  ConsolidationService,
  createEpisodicRetrieveContext,
  createMemoizingEmbeddingGateway,
  createApprovalGate,
  createIngestSourceTool,
  createLoggingAfterToolCall,
  createMemorySearchTool,
  createSemanticRetrieveContext,
  DrizzleEpisodicMemoryStore,
  DrizzleIdentityStore,
  DrizzleLeadStore,
  DrizzleProceduralStore,
  DrizzleProposalStore,
  DrizzleSemanticMemoryStore,
  DrizzleCompanionAffectStore,
  DrizzleCompanionEnergyStore,
  DrizzleTokenQuotaStore,
  DrizzleToolCallLog,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  type FakeTurn,
  Harness,
  InMemoryPresenceStore,
  IngestionPipeline,
  IngestionRunner,
  type IngestionTarget,
  DrizzleProactiveOutcomeStore,
  LlmIngestionAnnouncer,
  MotivationEngine,
  MotivationRunner,
  reinforceFromDelta,
  ToolRegistry,
  TranscriptMemoryStore,
  type Logger,
} from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../app.js';
import type { TokenVerifier, VerifiedClaims } from '../auth/jwt-verifier.js';
import type { AppConfig } from '../config.js';

export const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {} };

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
  ingestionQueueMax: 100,
  tokenCapPerDay: 1_000_000,
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
  /**
   * Replace the pipeline the motivation engine drives for autonomous reads. A
   * real read needs the network + scripted LLM passes, so route/DoD tests inject
   * a fake that marks the job done and bills the meter (Phase 4.1).
   */
  readonly motivationPipeline?: IngestionTarget;
}

export async function makeTestApp(
  chunks: readonly string[] | readonly FakeTurn[] = ['Hi', ' there'],
  logger: Logger = silentLogger,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const config: AppConfig = { ...testConfig, ...options.config };
  const { db, close: closeDb } = await createTestDatabase();
  const identity = new DrizzleIdentityStore(db);
  const memory = new TranscriptMemoryStore(db);
  const semantic = new DrizzleSemanticMemoryStore(db);
  const episodic = new DrizzleEpisodicMemoryStore(db);
  const quota = new DrizzleTokenQuotaStore(db, { defaultCapTokens: config.tokenCapPerDay });
  const embeddings = new FakeEmbeddingGateway();
  // Retrieval arms share a memoizing gateway (mirrors index.ts); ingestion and
  // consolidation use the raw fake.
  const retrievalEmbeddings = createMemoizingEmbeddingGateway(embeddings);
  const llmGateway = new FakeLlmGateway(chunks);
  const tokenVerifier = new FakeTokenVerifier();
  // Queue cap comes from config, mirroring production wiring (index.ts).
  const ingestionPipeline = new IngestionPipeline({
    semantic,
    llm: llmGateway,
    embeddings,
    ingestionModel: config.ingestionModel,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    useContextHeader: config.useContextHeader,
    quota,
    logger: silentLogger,
    announcer: new LlmIngestionAnnouncer({
      identity,
      memory,
      llm: llmGateway,
      model: config.ingestionModel,
      quota,
      logger: silentLogger,
    }),
  });
  const ingestion =
    options.ingestion ??
    new IngestionRunner(ingestionPipeline, silentLogger, config.ingestionQueueMax);
  const consolidation = new ConsolidationRunner(
    new ConsolidationService({
      episodic,
      memory,
      identity,
      llm: llmGateway,
      embeddings,
      consolidationModel: config.ingestionModel,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      quota,
      logger: silentLogger,
    }),
    silentLogger,
  );
  // The Phase 3 tool surface: read-only memory_search + effectful ingest_source
  // (web_fetch is omitted here — it needs a live resolver and isn't exercised by
  // route tests). The proposal store + audit log back the approval queue.
  const tools = new ToolRegistry([
    createMemorySearchTool({
      semantic,
      embeddings,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      logger: silentLogger,
    }),
    createIngestSourceTool({ semantic, ingestion, logger: silentLogger }),
  ]);
  const proposals = new DrizzleProposalStore(db);
  const toolCallLog = new DrizzleToolCallLog(db);
  const leads = new DrizzleLeadStore(db);
  const procedural = new DrizzleProceduralStore(db);
  const presence = new InMemoryPresenceStore();
  const energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: config.tokenCapPerDay });
  const rewards = new DrizzleProactiveOutcomeStore(db);
  const affectStore = new DrizzleCompanionAffectStore(db);
  const motivation = new MotivationRunner(
    new MotivationEngine(
      {
        identity,
        presence,
        energy,
        leads,
        semantic,
        pipeline: options.motivationPipeline ?? ingestionPipeline,
        memory,
        rewards,
        llm: llmGateway,
        model: config.ingestionModel,
        logger: silentLogger,
      },
      {},
    ),
    silentLogger,
  );
  const deps: AppDeps = {
    identity,
    memory,
    semantic,
    episodic,
    embeddings,
    ingestion,
    consolidation,
    tools,
    proposals,
    toolCallLog,
    leads,
    procedural,
    presence,
    motivation,
    energy,
    rewards,
    harness: new Harness({
      gateway: llmGateway,
      memory,
      model: 'test-model',
      quota,
      logger: silentLogger,
      // P4.2 affect loop: sense mood each turn, attune, and learn from the change.
      affect: {
        store: affectStore,
        model: config.ingestionModel,
        reinforce: (companionId, delta) =>
          reinforceFromDelta({ rewards, identity, logger: silentLogger }, companionId, delta),
      },
      registry: tools,
      beforeToolCall: createApprovalGate(proposals, tools, silentLogger),
      afterToolCall: createLoggingAfterToolCall(toolCallLog, silentLogger),
      retrieveContext: composeRetrieveContext(
        silentLogger,
        createEpisodicRetrieveContext({
          episodic,
          embeddings: retrievalEmbeddings,
          embeddingModel: config.embeddingModel,
          embeddingDimensions: config.embeddingDimensions,
          logger: silentLogger,
        }),
        createSemanticRetrieveContext({
          memory,
          semantic,
          embeddings: retrievalEmbeddings,
          embeddingModel: config.embeddingModel,
          embeddingDimensions: config.embeddingDimensions,
          logger: silentLogger,
        }),
      ),
    }),
    quota,
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
      await consolidation.whenIdle();
      // Drain proactive ticks (GET/POST messages request them) before the db
      // closes, so a background tick can't write to a torn-down database.
      await motivation.close();
      await app.close();
      await closeDb();
    },
  };
}
