/**
 * API entrypoint: loads config, wires the production dependency graph (stores,
 * gateways, ingestion pipeline + runner, harness with semantic recall), and
 * starts the Fastify server.
 */

import { createPgDatabase, EMBEDDING_DIMENSIONS } from '@cobble/db';
import {
  composeRetrieveContext,
  ConsolidationRunner,
  ConsolidationService,
  consoleLogger,
  createEpisodicRetrieveContext,
  createHttpLinkResolver,
  createMemoizingEmbeddingGateway,
  createApprovalGate,
  createIngestSourceTool,
  createLoggingAfterToolCall,
  createMemorySearchTool,
  createSemanticRetrieveContext,
  createSourceParser,
  createWebFetchTool,
  DrizzleEpisodicMemoryStore,
  DrizzleIdentityStore,
  DrizzleLeadStore,
  DrizzleProceduralStore,
  DrizzleProposalStore,
  DrizzleSemanticMemoryStore,
  DrizzleCompanionEnergyStore,
  DrizzleTokenQuotaStore,
  DrizzleToolCallLog,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  Harness,
  InMemoryPresenceStore,
  IngestionPipeline,
  IngestionRunner,
  LlmIngestionAnnouncer,
  LlmPersonalityEvolver,
  MotivationEngine,
  MotivationRunner,
  OpenRouterEmbeddingGateway,
  OpenRouterGateway,
  resumeDeferredJobs,
  sweepConsolidation,
  sweepMotivation,
  ToolRegistry,
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
  const episodic = new DrizzleEpisodicMemoryStore(db);
  const quota = new DrizzleTokenQuotaStore(db, { defaultCapTokens: config.tokenCapPerDay });
  const llmGateway = createGateway(config);
  const embeddings = createEmbeddingGateway(config);
  // Shared by the retrieve-context arms only: collapses each turn's duplicate
  // query embedding into one provider call. Ingestion keeps the raw gateway —
  // it embeds distinct chunks, so a one-entry memo would only ever miss.
  const retrievalEmbeddings = createMemoizingEmbeddingGateway(embeddings);

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

  // Phase 3 tool surface + trust machinery, built before the harness so the
  // propose→approve gate and the tool-call log can be wired into the loop.
  const proposals = new DrizzleProposalStore(db);
  const toolCallLog = new DrizzleToolCallLog(db);
  const leads = new DrizzleLeadStore(db);
  const procedural = new DrizzleProceduralStore(db);
  // Volatile presence (P4) — fed by the heartbeat route and message sends; the
  // motivation engine reads it to decide whether/how to initiate.
  const presence = new InMemoryPresenceStore();
  const tools = new ToolRegistry([
    // web_fetch harvests outbound links into the reading list (the P4 substrate).
    createWebFetchTool({
      resolver: createHttpLinkResolver({ maxBytes: config.ingestionMaxBytes }),
      leads,
      logger: consoleLogger,
    }),
    createMemorySearchTool({
      semantic,
      embeddings,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      logger: consoleLogger,
    }),
    createIngestSourceTool({ semantic, ingestion, logger: consoleLogger }),
  ]);

  const harness = new Harness({
    gateway: llmGateway,
    memory,
    model: config.llmModel,
    quota,
    logger: consoleLogger,
    // P3: the tools the model may call, the propose→approve gate (effectful calls
    // are held for approval), and the audit log (every call is logged).
    registry: tools,
    beforeToolCall: createApprovalGate(proposals, tools, consoleLogger),
    afterToolCall: createLoggingAfterToolCall(toolCallLog, consoleLogger),
    // The memory-retrieval hook (invariant #3): episodic recall (P2) first, then
    // semantic recall (P1) which appends the recency transcript window last — so
    // a turn carries persona + memories + grounding + recent transcript, in order.
    retrieveContext: composeRetrieveContext(
      consoleLogger,
      createEpisodicRetrieveContext({
        episodic,
        // Both arms embed the same query; a shared one-entry memo collapses the
        // duplicate into one provider round-trip (the arms run sequentially).
        embeddings: retrievalEmbeddings,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        logger: consoleLogger,
      }),
      createSemanticRetrieveContext({
        memory,
        semantic,
        embeddings: retrievalEmbeddings,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        logger: consoleLogger,
      }),
    ),
  });

  // Episodic consolidation (P2): a metered reflection pass turns the transcript
  // into episodes off the request path, and personality evolution grows the
  // companion from them. The cheap ingestion model handles both reading passes.
  const evolver = new LlmPersonalityEvolver({
    identity,
    episodic,
    llm: llmGateway,
    model: config.ingestionModel,
    quota,
    logger: consoleLogger,
  });
  const consolidationService = new ConsolidationService({
    episodic,
    memory,
    identity,
    llm: llmGateway,
    embeddings,
    consolidationModel: config.ingestionModel,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    quota,
    logger: consoleLogger,
    evolver,
  });
  const consolidation = new ConsolidationRunner(consolidationService, consoleLogger);

  // Motivation engine (P4): the "will" that works the lead inventory on idle.
  // Self-initiated work draws the per-companion ENERGY pool (separate from the
  // user stamina pool, so autonomy can't starve chat). The runner keeps ticks off
  // the request path; routes request() it on activity/return + a periodic sweep.
  const energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: config.tokenCapPerDay });
  const motivationEngine = new MotivationEngine({
    identity,
    presence,
    energy,
    leads,
    proposals,
    tools,
    logger: consoleLogger,
  });
  const motivation = new MotivationRunner(motivationEngine, consoleLogger);

  const app = await buildApp({
    identity,
    memory,
    semantic,
    episodic,
    embeddings,
    ingestion,
    consolidation,
    harness,
    tools,
    proposals,
    toolCallLog,
    leads,
    procedural,
    presence,
    motivation,
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

  // Episodic consolidation catch-up: on startup and on a timer, request a
  // reflection for any companion whose un-consolidated transcript tail is long
  // enough (the runner coalesces + the service re-checks the threshold/cap). This
  // also recovers companions whose post-turn trigger was lost to a restart.
  const consolidationSweepDeps = { episodic, runner: consolidation, logger: consoleLogger };
  await sweepConsolidation(consolidationSweepDeps);
  const consolidationTimer = setInterval(() => {
    void sweepConsolidation(consolidationSweepDeps).catch((error: unknown) => {
      consoleLogger.error('consolidation sweep failed', { error });
    });
  }, CONSOLIDATION_SWEEP_INTERVAL_MS);
  consolidationTimer.unref();

  // Proactivity catch-up (P4): on startup and on a timer, request a tick for any
  // companion with unread leads — recovering companions whose activity/return
  // trigger was lost to a restart. The engine's gate still decides whether to act.
  const motivationSweepDeps = { leads, runner: motivation, logger: consoleLogger };
  await sweepMotivation(motivationSweepDeps);
  const motivationTimer = setInterval(() => {
    void sweepMotivation(motivationSweepDeps).catch((error: unknown) => {
      consoleLogger.error('motivation sweep failed', { error });
    });
  }, MOTIVATION_SWEEP_INTERVAL_MS);
  motivationTimer.unref();

  // Graceful shutdown: stop the catch-up timers and drain in-flight background
  // work before exit so nothing is killed mid-write. Fastify runs onClose after
  // it has stopped accepting requests, so no new turns trigger work past here.
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    clearInterval(consolidationTimer);
    clearInterval(motivationTimer);
    await ingestion.whenIdle();
    await consolidation.close();
    await motivation.close();
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      consoleLogger.info('shutting down', { signal });
      void app.close().catch((error: unknown) => {
        consoleLogger.error('graceful shutdown failed', { signal, error });
        process.exitCode = 1;
      });
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  consoleLogger.info('api listening', { port: config.port });
}

/** How often to resume deferred ingestion jobs (cheap; just a status scan). */
const DEFERRED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** How often to catch up episodic consolidation (cheap; a pending-tail scan). */
const CONSOLIDATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** How often to catch up proactive ticks (cheap; a leads-pending scan). */
const MOTIVATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

main().catch((error: unknown) => {
  consoleLogger.error('api failed to start', { error });
  process.exitCode = 1;
});
