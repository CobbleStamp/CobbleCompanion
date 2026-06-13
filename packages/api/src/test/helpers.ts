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
  createReactTool,
  createProceduralRetrieveContext,
  createSemanticRetrieveContext,
  createUserModelRetrieveContext,
  DEFAULT_GROWTH_CONFIG,
  DrizzleEpisodicMemoryStore,
  DrizzleGrowthStore,
  DrizzleIdentityStore,
  DrizzleLeadStore,
  DrizzleProceduralStore,
  DrizzleProposalStore,
  DrizzleSemanticMemoryStore,
  DrizzleUserModelStore,
  DrizzleCompanionAffectStore,
  DrizzleVitalityStore,
  DrizzleFoodStore,
  DrizzleToolCallLog,
  type CliToolStore,
  type CommandSandbox,
  type EmbeddingGateway,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  FakeMcpGateway,
  type FakeTurn,
  GreetingService,
  GrowthService,
  Harness,
  InMemoryPresenceStore,
  IngestionPipeline,
  IngestionRunner,
  type IngestionTarget,
  DrizzleProactiveOutcomeStore,
  DrizzleReactionStore,
  ReactionLearner,
  LlmIngestionAnnouncer,
  type McpGateway,
  LlmUserModelReflector,
  LlmUserPersonaSynthesizer,
  MotivationEngine,
  MotivationRunner,
  reinforceFromDelta,
  InProcessCompanionEventBus,
  PublishingMemoryStore,
  type RetrieveContext,
  ToolRegistry,
  TranscriptMemoryStore,
  type Logger,
} from '@cobble/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../app.js';
import { buildToolAcquisitionWiring } from '../acquisition/wiring.js';
import {
  bearerToken,
  type AuthClaims,
  type AuthRequest,
  type TokenVerifier,
} from '../auth/jwt-verifier.js';
import type { AppConfig } from '../config.js';

export const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {} };

/**
 * Token verifier for tests: maps a known token string to claims, throwing on
 * anything unregistered. Lets tests exercise the auth boundary without signing
 * real RS256 tokens or touching JWKS (fakes-over-mocks).
 */
export class FakeTokenVerifier implements TokenVerifier {
  private readonly byToken = new Map<string, AuthClaims>();

  set(token: string, claims: AuthClaims): void {
    this.byToken.set(token, claims);
  }

  async verify(request: AuthRequest): Promise<AuthClaims> {
    const token = bearerToken(request.authorization);
    const claims = token ? this.byToken.get(token) : undefined;
    return (
      claims ?? {
        ok: false,
        failure: { status: 401, kind: 'invalid', message: 'invalid token' },
      }
    );
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
  startingVitalityTokens: 1_000_000,
  mcpServers: [],
  serviceRegistrySeeds: [],
  maxEquippedTools: 8,
  cliToolsPath: '',
  cliScratchDir: '',
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
  /** The shared fake LLM gateway — `gateway.calls` lets a test assert what context a
   *  turn was given (e.g. that a learned belief reached a later turn's prompt). */
  readonly gateway: FakeLlmGateway;
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
   * `config.mcpServers` whitelist, this wires the catalog + search_tools/load_tool
   * + the per-step equipped resolver over the fake (fakes-over-mocks). The catalog
   * is built from the whitelist at app construction.
   */
  readonly mcpGateway?: McpGateway;
  /**
   * Inject a CLI tool store + sandbox for Phase 10 tests. Combined with a
   * `config.cliToolsPath`, this wires host CLIs as a capability source: the catalog
   * indexes the store's tools and search_tools/load_tool + the per-step resolver
   * run them through the sandbox. Tests pass a real FileSystemCliToolStore over a
   * temp fixture dir + a FakeCommandSandbox (deterministic, cross-platform).
   */
  readonly cliToolStore?: CliToolStore;
  readonly cliSandbox?: CommandSandbox;
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
  /**
   * Replace the embedding gateway (default: a fresh {@link FakeEmbeddingGateway}).
   * The hash fake makes every distinct string near-orthogonal, which can't model
   * the topical adjacency real embeddings have (e.g. "what should we get into
   * next" sitting near "the user is interested in jazz"). A test that exercises
   * vector-arm recall across such a turn injects a fake that models that adjacency.
   */
  readonly embeddings?: EmbeddingGateway;
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
  const identity = new DrizzleIdentityStore(db, {
    startingVitalityTokens: config.startingVitalityTokens,
  });
  const userModel = new DrizzleUserModelStore(db);
  // Mirror production wiring (index.ts): the publish-on-append decorator over the
  // transcript store so tests exercise the same event-channel publish path.
  const eventBus = new InProcessCompanionEventBus();
  const memory = new PublishingMemoryStore(new TranscriptMemoryStore(db), eventBus, silentLogger);
  const reactions = new DrizzleReactionStore(db);
  const semantic = new DrizzleSemanticMemoryStore(db);
  const episodic = new DrizzleEpisodicMemoryStore(db);
  const quota = new DrizzleVitalityStore(db, 'stamina');
  const embeddings = options.embeddings ?? new FakeEmbeddingGateway();
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
  // Phase 12: the User-Model Reflector derives Tier-2 beliefs from the transcript on
  // its own cursor; the consolidation service fires it after each run.
  const userModelReflector = new LlmUserModelReflector({
    identity,
    memory,
    store: userModel,
    llm: llmGateway,
    embeddings,
    model: config.ingestionModel,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    quota,
    logger: silentLogger,
  });
  // Phase 13: the Tier-3 user-persona synthesizer, fired after the reflector.
  const userPersonaSynthesizer = new LlmUserPersonaSynthesizer({
    identity,
    episodic,
    store: userModel,
    llm: llmGateway,
    model: config.ingestionModel,
    quota,
    logger: silentLogger,
  });
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
      reflector: userModelReflector,
      userPersonaSynthesizer,
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
    createReactTool({ reactions, eventBus, logger: silentLogger }),
  ];
  // Phases 9–10: wire tool acquisition when the test configures a source — an MCP
  // whitelist + a (fake) gateway, and/or a CLI tools path + an injected store +
  // sandbox; off otherwise (behaviour identical to pre-Phase-9).
  const acquisitionWiring = buildToolAcquisitionWiring({
    config,
    db,
    mcpGateway: options.mcpGateway ?? new FakeMcpGateway(),
    ...(options.cliToolStore ? { cliToolStore: options.cliToolStore } : {}),
    ...(options.cliSandbox ? { cliSandbox: options.cliSandbox } : {}),
    llmGateway,
    baseTools,
    quota,
    logger: silentLogger,
  });
  // Mirror production startup: build the discovery catalog from the sources so a
  // configured test can search_tools/load_tool immediately.
  if (acquisitionWiring) {
    await acquisitionWiring.refreshCatalog();
  }
  const tools = new ToolRegistry(acquisitionWiring ? acquisitionWiring.nativeTools : baseTools);
  const proposals = new DrizzleProposalStore(db);
  const toolCallLog = new DrizzleToolCallLog(db);
  const leads = new DrizzleLeadStore(db);
  const procedural = new DrizzleProceduralStore(db);
  const presence = new InMemoryPresenceStore();
  const energy = new DrizzleVitalityStore(db, 'energy');
  const food = new DrizzleFoodStore(db, { initialFood: DEFAULT_GROWTH_CONFIG.initialFood });
  const rewards = new DrizzleProactiveOutcomeStore(db);
  const affectStore = new DrizzleCompanionAffectStore(db);
  const reactionLearner = new ReactionLearner({
    rewards,
    reactions,
    identity,
    memory,
    userModel,
    sense: { llm: llmGateway, model: config.ingestionModel, logger: silentLogger, quota },
    logger: silentLogger,
  });
  // Growth (P5) — derived four-axis growth over the same db (decoupled from feeding).
  const growthStore = new DrizzleGrowthStore(db);
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
        // Phase 12: curiosity sources its topics from the user's interest beliefs.
        userModel,
        llm: llmGateway,
        model: config.ingestionModel,
        logger: silentLogger,
      },
      {},
    ),
    silentLogger,
  );
  // Greeting on arrival (P14) — voiced greetings spend STAMINA (the `quota` wallet).
  const greeting = new GreetingService({
    identity,
    memory,
    proposals,
    rewards,
    userModel,
    stamina: quota,
    llm: llmGateway,
    model: config.ingestionModel,
    logger: silentLogger,
  });
  const deps: AppDeps = {
    identity,
    userModel,
    memory,
    eventBus,
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
    greeting,
    energy,
    food,
    rewards,
    reactions,
    reactionLearner,
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
                reinforceFromDelta(
                  { rewards, identity, userModel, logger: silentLogger },
                  companionId,
                  delta,
                ),
            },
          }),
      // Phase 11: Tier-1 persona injection + post-turn identity-fact capture.
      // Phase 12: also capture explicit Tier-2 beliefs, embedded for hybrid recall.
      userModel: {
        store: userModel,
        model: config.ingestionModel,
        embeddings: retrievalEmbeddings,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
      },
      registry: tools,
      ...(acquisitionWiring ? { resolveRegistry: acquisitionWiring.resolveRegistry } : {}),
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
          createProceduralRetrieveContext({
            procedural,
            logger: silentLogger,
            ...(acquisitionWiring ? { loadAdvisor: acquisitionWiring.loadAdvisor } : {}),
          }),
          ...(acquisitionWiring ? [acquisitionWiring.equippedArm] : []),
          // Phase 12: the Tier-2 belief arm, before the semantic arm (recency last).
          createUserModelRetrieveContext({
            store: userModel,
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
    tokenVerifier.set(token, { ok: true, identity: { authSource: 'google', email: address } });
    return { authorization: `Bearer ${token}` };
  };

  return {
    app,
    deps,
    tokenVerifier,
    gateway: llmGateway,
    bearerFor,
    close: async () => {
      await ingestion.whenIdle();
      await consolidation.whenIdle();
      // Drain proactive ticks (GET/POST messages request them) before the db
      // closes, so a background tick can't write to a torn-down database.
      await motivation.close();
      // Drain fire-and-forget reaction reads (the POST reaction route floats one)
      // for the same reason — a detached read must not outlive the db.
      await reactionLearner.whenIdle();
      // Growth recompute runs inline as the tail of each turn's stream, so there's
      // no background runner to drain here.
      await app.close();
      if (ownsDb) {
        await closeDb();
      }
    },
  };
}
