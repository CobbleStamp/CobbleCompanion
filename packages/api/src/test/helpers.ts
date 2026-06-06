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
  createProceduralRetrieveContext,
  createSemanticRetrieveContext,
  DEFAULT_GROWTH_CONFIG,
  DrizzleEpisodicMemoryStore,
  DrizzleGrowthStore,
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
  FakeMcpGateway,
  type FakeTurn,
  GrowthService,
  Harness,
  InMemoryPresenceStore,
  IngestionPipeline,
  IngestionRunner,
  type IngestionTarget,
  DrizzleProactiveOutcomeStore,
  LlmIngestionAnnouncer,
  type McpGateway,
  MotivationEngine,
  MotivationRunner,
  reinforceFromDelta,
  type RetrieveContext,
  ToolRegistry,
  TranscriptMemoryStore,
  type Logger,
} from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../app.js';
import { buildMcpWiring } from '../mcp/wiring.js';
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
  mcpServers: [],
  appUrl: 'http://localhost:3001',
  authMode: 'google',
  googleClientId: 'test-google-client-id',
  devBypassEmail: 'dev@cobble.local',
  port: 0,
  isProduction: false,
  tracingProvider: 'none',
  langfusePublicKey: '',
  langfuseSecretKey: '',
  langfuseHost: 'https://cloud.langfuse.com',
  tracingSampleRate: 0,
  tracingRedact: 'strict',
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
  /**
   * Inject an MCP gateway (a FakeMcpGateway) for Phase 9 tests. Combined with a
   * `config.mcpServers` whitelist, this wires connect_mcp + the per-companion
   * resolver + the tool-retrieval arm over the fake (fakes-over-mocks).
   */
  readonly mcpGateway?: McpGateway;
  /**
   * Omit the per-turn affect read (Phase 4.2). It shares the FakeLlmGateway, so a
   * test that drives several messages and asserts an exact scripted-turn sequence
   * (e.g. the Phase 9 DoD) sets this to keep the sequence deterministic.
   */
  readonly disableAffect?: boolean;
  /**
   * Reuse an existing test database instead of creating a fresh one. Lets a test
   * build two apps over the SAME persisted store — exercising a true process
   * restart (a cold registry rebuild from the persisted connections) rather than
   * just a second turn on the same running app. When provided, the caller owns the
   * db lifecycle: the returned `close()` tears down the app but leaves the db open.
   */
  readonly database?: Awaited<ReturnType<typeof createTestDatabase>>;
}

export async function makeTestApp(
  chunks: readonly string[] | readonly FakeTurn[] = ['Hi', ' there'],
  logger: Logger = silentLogger,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const config: AppConfig = { ...testConfig, ...options.config };
  // When the caller passes a shared db it owns the lifecycle (see `database`
  // option); otherwise we create one here and close it on teardown.
  const ownsDb = options.database === undefined;
  const { db, close: closeDb } = options.database ?? (await createTestDatabase());
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
  const baseTools = [
    createMemorySearchTool({
      semantic,
      embeddings,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      logger: silentLogger,
    }),
    createIngestSourceTool({ semantic, ingestion, logger: silentLogger }),
  ];
  // Phase 9: wire MCP tool acquisition when the test configures a whitelist +
  // injects a (fake) gateway; off otherwise (behaviour identical to pre-Phase-9).
  const mcpWiring = buildMcpWiring({
    config,
    db,
    gateway: options.mcpGateway ?? new FakeMcpGateway(),
    baseTools,
    logger: silentLogger,
  });
  const tools = new ToolRegistry(mcpWiring ? mcpWiring.nativeTools : baseTools);
  const proposals = new DrizzleProposalStore(db);
  const toolCallLog = new DrizzleToolCallLog(db);
  const leads = new DrizzleLeadStore(db);
  const procedural = new DrizzleProceduralStore(db);
  const presence = new InMemoryPresenceStore();
  const energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: config.tokenCapPerDay });
  const rewards = new DrizzleProactiveOutcomeStore(db);
  const affectStore = new DrizzleCompanionAffectStore(db);
  // Growth & feeding economy (P5) — derived four-axis growth + treats over the same db.
  const growthStore = new DrizzleGrowthStore(db, {
    initialTreats: DEFAULT_GROWTH_CONFIG.initialTreats,
  });
  const growth = new GrowthService({
    identity,
    semantic,
    episodic,
    procedural,
    toolCallLog,
    rewards,
    affect: affectStore,
    growth: growthStore,
    memory,
    logger: silentLogger,
  });
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
    growth,
    growthStore,
    harness: new Harness({
      gateway: llmGateway,
      memory,
      model: 'test-model',
      quota,
      logger: silentLogger,
      // P4.2 affect loop: sense mood each turn, attune, and learn from the change.
      ...(options.disableAffect
        ? {}
        : {
            affect: {
              store: affectStore,
              model: config.ingestionModel,
              reinforce: (companionId, delta) =>
                reinforceFromDelta({ rewards, identity, logger: silentLogger }, companionId, delta),
            },
          }),
      registry: tools,
      ...(mcpWiring ? { resolveRegistry: mcpWiring.resolveRegistry } : {}),
      beforeToolCall: createApprovalGate(proposals, tools, silentLogger),
      afterToolCall: createLoggingAfterToolCall(toolCallLog, silentLogger),
      retrieveContext: composeRetrieveContext(
        silentLogger,
        ...([
          createEpisodicRetrieveContext({
            episodic,
            embeddings: retrievalEmbeddings,
            embeddingModel: config.embeddingModel,
            embeddingDimensions: config.embeddingDimensions,
            logger: silentLogger,
          }),
          createProceduralRetrieveContext({ procedural, logger: silentLogger }),
          ...(mcpWiring ? [mcpWiring.toolArm] : []),
          createSemanticRetrieveContext({
            memory,
            semantic,
            embeddings: retrievalEmbeddings,
            embeddingModel: config.embeddingModel,
            embeddingDimensions: config.embeddingDimensions,
            logger: silentLogger,
          }),
        ] satisfies RetrieveContext[]),
      ),
    }),
    quota,
    affect: affectStore,
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
      // Growth recompute runs inline as the tail of each turn's stream, so there's
      // no background runner to drain here.
      await app.close();
      if (ownsDb) {
        await closeDb();
      }
    },
  };
}
