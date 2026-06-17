/**
 * API entrypoint: loads config, wires the production dependency graph (stores,
 * gateways, ingestion pipeline + runner, harness with semantic recall), and
 * starts the Fastify server.
 */

import { hostname } from 'node:os';
import { createPgDatabase, EMBEDDING_DIMENSIONS, seedCredentials, type Database } from '@cobble/db';
import {
  composeRetrieveContext,
  ConsolidationService,
  consoleLogger,
  createEpisodicRetrieveContext,
  createHttpLinkResolver,
  createMemoizingEmbeddingGateway,
  createApprovalGate,
  createIngestSourceTool,
  createLoggingAfterToolCall,
  createMemorySearchTool,
  createReactTool,
  createProceduralRetrieveContext,
  createSemanticRetrieveContext,
  createUserModelRetrieveContext,
  createSourceParser,
  createWebFetchTool,
  DrizzleEpisodicMemoryStore,
  DrizzleIdentityStore,
  DrizzleServiceRegistry,
  DrizzleLeadStore,
  DrizzleProceduralStore,
  DrizzleProactiveOutcomeStore,
  DrizzleProposalStore,
  DrizzleReactionStore,
  ReactionLearner,
  DrizzleSemanticMemoryStore,
  DrizzleCompanionAffectStore,
  DrizzleVitalityStore,
  DrizzleFoodStore,
  DrizzleToolCallLog,
  DrizzleGrowthStore,
  DrizzleUserModelStore,
  FakeEmbeddingGateway,
  FakeLlmGateway,
  GreetingService,
  GrowthService,
  DEFAULT_GROWTH_CONFIG,
  Harness,
  EmbodimentPresenceStore,
  IngestionPipeline,
  DrizzleEmbodimentStore,
  DrizzleUploadStagingStore,
  makeIngestJobHandler,
  makeIngestWorkRequester,
  sweepIngestion,
  LlmIngestionAnnouncer,
  LlmPersonalityEvolver,
  LlmUserModelReflector,
  LlmUserPersonaSynthesizer,
  MotivationEngine,
  OpenRouterEmbeddingGateway,
  OpenRouterGateway,
  reinforceFromDelta,
  sweepConsolidation,
  sweepMotivation,
  ToolRegistry,
  DurableCompanionEventBus,
  DrizzleCompanionEventLog,
  PublishingMemoryStore,
  TranscriptMemoryStore,
  DrizzleJobQueue,
  JobProcessorPool,
  makeCompanionWorkRequester,
  makeReactionWorkRequester,
  type EmbeddingGateway,
  type LlmGateway,
} from '@cobble/core';
import { buildApp } from './app.js';
import {
  CompositeVerifier,
  GoogleIdTokenVerifier,
  ServiceTokenVerifier,
  type TokenVerifier,
} from './auth/jwt-verifier.js';
import { loadConfig, type AppConfig } from './config.js';
import { FileSystemCliToolStore } from './cli/fs-tool-store.js';
import { createSubprocessSandbox } from './cli/subprocess-sandbox.js';
import { StreamableHttpMcpGateway } from './mcp/sdk-client.js';
import { buildToolAcquisitionWiring } from './acquisition/wiring.js';
import { createTraceSink } from './tracing/langfuse-sink.js';

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

// Both schemes are live at once; the composite routes each request by its credentials
// (jwt-verifier.ts): service callers by the X-Service-Client-Id header, browser bearers
// to Google.
function createTokenVerifier(config: AppConfig, db: Database): TokenVerifier {
  return new CompositeVerifier(
    new GoogleIdTokenVerifier(config.googleClientId),
    new ServiceTokenVerifier(new DrizzleServiceRegistry(db)),
  );
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

  // Provision configured server-to-server consumer credentials (implementation.md §5):
  // additive + idempotent, so re-seeding the same pairs each launch is a no-op. A failing
  // insert means a real DB problem, so let it propagate and fail boot (unlike the
  // best-effort catalog refresh below). Only counts are logged — never a secret.
  if (config.serviceRegistrySeeds.length > 0) {
    const { inserted, skipped } = await seedCredentials(db, config.serviceRegistrySeeds);
    consoleLogger.info('service registry seeded', {
      operation: 'service-registry.seed',
      inserted,
      skipped,
    });
  }

  // New companions get both vitality wallets seeded from STARTING_VITALITY_TOKENS.
  const identity = new DrizzleIdentityStore(db, {
    startingVitalityTokens: config.startingVitalityTokens,
  });
  // The User Model (Phase 11) — seeds the name on sign-in, feeds the persona, and
  // captures stated identity facts post-turn (companion-memory.md §4).
  const userModel = new DrizzleUserModelStore(db);
  // The standing companion event channel's substrate (architecture.md §6): the
  // bus fans appended rows out to subscribed surfaces, and wrapping the store in a
  // publish-on-append decorator HERE means every persistence path downstream
  // (announcer, harness, greeter) publishes through the one shared instance.
  // Durable cross-node delivery (D4): publishes append to companion_events, which the
  // live embodiment connection's heartbeat reads by cursor on any node (the log is
  // the single delivery substrate — the SSE in-process bus is gone).
  const eventLog = new DrizzleCompanionEventLog(db);
  const eventBus = new DurableCompanionEventBus(eventLog, consoleLogger);
  const memory = new PublishingMemoryStore(new TranscriptMemoryStore(db), eventBus, consoleLogger);
  // Reinforcement log + the rolling affect read — built early so the harness can
  // sense the user's mood each turn (Phase 4.2) and the will can learn from it.
  const rewards = new DrizzleProactiveOutcomeStore(db);
  const affectStore = new DrizzleCompanionAffectStore(db);
  const reactions = new DrizzleReactionStore(db);
  const semantic = new DrizzleSemanticMemoryStore(db);
  const episodic = new DrizzleEpisodicMemoryStore(db);
  const quota = new DrizzleVitalityStore(db, 'stamina');
  const llmGateway = createGateway(config);
  const embeddings = createEmbeddingGateway(config);
  // The will's half of the reaction loop (companion-reactions.md §4): reads a user
  // reaction's value (cheap ingestion model, billed to stamina) and learns from it
  // after the route responds. Same body-senses/will-learns split as the affect loop.
  const reactionLearner = new ReactionLearner({
    rewards,
    reactions,
    identity,
    memory,
    userModel,
    sense: { llm: llmGateway, model: config.ingestionModel, logger: consoleLogger, quota },
    logger: consoleLogger,
  });
  // Shared by the retrieve-context arms only: collapses each turn's duplicate
  // query embedding into one provider call. Ingestion keeps the raw gateway —
  // it embeds distinct chunks, so a one-entry memo would only ever miss.
  const retrievalEmbeddings = createMemoizingEmbeddingGateway(embeddings);

  // The pipeline is shared: the runner drains user uploads through it (billed to
  // stamina), and the motivation engine drives it directly for autonomous reads
  // (billed to energy via a per-run meter override — `pipeline.ts`).
  const ingestionPipeline = new IngestionPipeline({
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
  });
  // Two-part-upload staging: an intake stores bytes here, then enqueues an
  // `ingest` job that reads them on any node (deliver-scalability.md §6 D-A).
  const staging = new DrizzleUploadStagingStore(db);

  // Live embodiment claim (Phase D D2): one WS connection holds a companion at a
  // time; the handshake claims it and the heartbeat renews it.
  const embodiment = new DrizzleEmbodimentStore(db);

  // Background job queue (deliver-scalability.md §5.1): the durable, fleet-coherent
  // replacement for the in-process runners + their per-process coalescing Sets.
  // consolidate/motivation/reaction_learn/ingest run as claim-serialised jobs
  // drained by a bounded pool on every node, so duplicate sweeps can't run the same
  // work N times and a reaction's drive-weight write can't race a concurrent one.
  // The consolidate/motivation/reaction_learn handlers reference services
  // constructed below; they only run at drain time (after pool.start()), so the
  // forward reference is safe. Built here — before the tool registry — because the
  // `ingest_source` tool and the upload routes enqueue through the same requester.
  const jobQueue = new DrizzleJobQueue(db);
  const jobPool = new JobProcessorPool(
    jobQueue,
    {
      consolidate: (job) => consolidationService.consolidate(job.companionId),
      motivation: async (job) => {
        await motivationEngine.tick(job.companionId);
      },
      reaction_learn: async (job) => {
        const { messageId, emoji } = job.payload;
        if (!messageId || !emoji) {
          return;
        }
        await reactionLearner.learnForMessage(job.companionId, messageId, emoji);
      },
      ingest: makeIngestJobHandler({
        pipeline: ingestionPipeline,
        semantic,
        staging,
        logger: consoleLogger,
      }),
    },
    {
      owner: `${hostname()}-${process.pid}`,
      concurrency: JOB_CONCURRENCY,
      leaseMs: JOB_LEASE_MS,
      pollMs: JOB_POLL_INTERVAL_MS,
      logger: consoleLogger,
    },
  );
  // Triggers (message routes, reaction route, intake routes/tool) + the catch-up
  // sweeps enqueue through these requesters — coalesced, with a local nudge.
  const consolidation = makeCompanionWorkRequester(jobPool, 'consolidate');
  const motivation = makeCompanionWorkRequester(jobPool, 'motivation');
  const reactionLearn = makeReactionWorkRequester(jobPool);
  const ingest = makeIngestWorkRequester(jobPool, jobQueue, config.ingestionQueueMax);

  // Phase 3 tool surface + trust machinery, built before the harness so the
  // propose→approve gate and the tool-call log can be wired into the loop.
  const proposals = new DrizzleProposalStore(db);
  const toolCallLog = new DrizzleToolCallLog(db);
  const leads = new DrizzleLeadStore(db);
  const procedural = new DrizzleProceduralStore(db);
  // Presence (P4) derived from the live embodiment claim (D5): a live claim means
  // the user is here. Fleet-wide (shared Postgres), so a turn on one node and a
  // motivation tick on another see the same presence; a dropped connection becomes
  // absent when its claim lapses. The motivation engine reads it to decide whether
  // to self-initiate.
  const presence = new EmbodimentPresenceStore(db, config.wsClaimTtlMs, consoleLogger);
  const baseTools = [
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
    createIngestSourceTool({ semantic, ingest, staging, logger: consoleLogger }),
    // The companion's expressive emoji reaction (companion-reactions.md §5): free,
    // ungated, silent; binds to the message that triggered the turn.
    createReactTool({ reactions, eventBus, logger: consoleLogger }),
  ];
  // Phases 9–10: runtime tool acquisition. Off unless MCP_SERVERS and/or
  // CLI_TOOLS_PATH is configured — then search_tools/load_tool join the native core
  // tools, the catalog indexes the whitelisted tools off-context, a per-step
  // resolver advertises the companion's equipped tools, and an arm lists what's
  // currently equipped. MCP proxies over HTTP; CLI runs a sandboxed subprocess.
  const mcpGateway = new StreamableHttpMcpGateway(consoleLogger);
  const cliEnabled = config.cliToolsPath.length > 0;
  const acquisitionWiring = buildToolAcquisitionWiring({
    config,
    db,
    mcpGateway,
    ...(cliEnabled
      ? {
          cliToolStore: new FileSystemCliToolStore(config.cliToolsPath, consoleLogger),
          cliSandbox: createSubprocessSandbox({
            scratchDir: config.cliScratchDir,
            logger: consoleLogger,
          }),
        }
      : {}),
    llmGateway,
    baseTools,
    quota,
    logger: consoleLogger,
  });
  if (acquisitionWiring) {
    // Build the discovery catalog from the configured sources at startup
    // (best-effort: a source that's down keeps its stale entries; never blocks boot).
    const indexed = await acquisitionWiring.refreshCatalog();
    consoleLogger.info('tool catalog built', { operation: 'acquisition.startup', tools: indexed });
  }
  const tools = new ToolRegistry(acquisitionWiring ? acquisitionWiring.nativeTools : baseTools);
  const retrieveArms = [
    createEpisodicRetrieveContext({
      episodic,
      // Both arms embed the same query; a shared one-entry memo collapses the
      // duplicate into one provider round-trip (the arms run sequentially).
      embeddings: retrievalEmbeddings,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      logger: consoleLogger,
    }),
    // Procedural retrieval-as-hint (P5): surface a relevant learned routine so
    // the capabilities checklist is functional. Grounding-only (no recency).
    // With tool acquisition on, the routine also drives proactive loading (§5).
    createProceduralRetrieveContext({
      procedural,
      logger: consoleLogger,
      ...(acquisitionWiring ? { loadAdvisor: acquisitionWiring.loadAdvisor } : {}),
    }),
    // Phase 9: list the companion's currently-equipped tools (grounding-only),
    // before the semantic arm, which appends the recency window last.
    ...(acquisitionWiring ? [acquisitionWiring.equippedArm] : []),
    // Phase 12: the Tier-2 user-model arm — relevant learned beliefs about the user as a
    // "what I know about you" grounding block. Grounding-only (no recency), before semantic.
    createUserModelRetrieveContext({
      store: userModel,
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
  ];

  const harness = new Harness({
    gateway: llmGateway,
    memory,
    model: config.llmModel,
    quota,
    logger: consoleLogger,
    // Phase C: online tracing. noop unless TRACING_PROVIDER=langfuse + keys set
    // (runbook-tracing.md) — a turn trace with assemble_context/llm_call/tool_call
    // spans, sampled + redacted before any third-party export.
    traceSink: createTraceSink(config, consoleLogger),
    // P4.2: sense the user's mood each turn (cheap ingestion model, billed to
    // stamina), attune the next reply to it, and let the *change* nudge the served
    // drive's weight when a self-directed act is awaiting a reaction.
    affect: {
      store: affectStore,
      model: config.ingestionModel,
      reinforce: (companionId, delta) =>
        reinforceFromDelta(
          { rewards, identity, userModel, logger: consoleLogger },
          companionId,
          delta,
        ),
    },
    // Phase 11: read the user's Tier-1 core profile into the persona each turn and
    // capture explicit identity facts they state (cheap ingestion model, billed to
    // stamina). Phase 12: also capture explicit Tier-2 beliefs, embedded for hybrid recall.
    userModel: {
      store: userModel,
      model: config.ingestionModel,
      embeddings: retrievalEmbeddings,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
    },
    // P3: the tools the model may call, the propose→approve gate (effectful calls
    // are held for approval), and the audit log (every call is logged).
    registry: tools,
    // Phase 9: when MCP is configured, the turn's effective registry is resolved
    // PER STEP (core tools + the companion's equipped tools), so a load_tool mid-turn is
    // callable next step. The gate keeps the native registry — MCP tools are
    // non-effectful and pass through it.
    ...(acquisitionWiring ? { resolveRegistry: acquisitionWiring.resolveRegistry } : {}),
    beforeToolCall: createApprovalGate(proposals, tools, consoleLogger),
    afterToolCall: createLoggingAfterToolCall(toolCallLog, consoleLogger),
    // The memory-retrieval hook (invariant #3): episodic + procedural + (MCP tool
    // hint) grounding arms, then the semantic arm which appends the recency window
    // last — so a turn carries persona + memories + grounding + recent transcript.
    retrieveContext: composeRetrieveContext(consoleLogger, ...retrieveArms),
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
  // Phase 12: the User-Model Reflector derives the user's Tier-2 beliefs from the same
  // transcript on its own cursor, reconciling against what's known. Fired by the
  // consolidation service after each run; self-gating + metered + never throws.
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
    logger: consoleLogger,
  });
  // Phase 13: the Tier-3 user-persona synthesizer — mirror of the Personality Evolver,
  // pointed at the user. Fired after the reflector on its own cursor; self-gating + metered.
  const userPersonaSynthesizer = new LlmUserPersonaSynthesizer({
    identity,
    episodic,
    store: userModel,
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
    reflector: userModelReflector,
    userPersonaSynthesizer,
  });

  // Motivation engine (P4): the "will" that works the lead inventory on idle.
  // Self-initiated work spends the per-companion ENERGY wallet (a separate wallet
  // from stamina, so autonomy can't starve chat). The runner keeps ticks off the
  // request path; routes request() it on activity/return + a periodic sweep.
  const energy = new DrizzleVitalityStore(db, 'energy');
  const motivationEngine = new MotivationEngine({
    identity,
    presence,
    energy,
    leads,
    semantic,
    pipeline: ingestionPipeline,
    memory,
    rewards,
    // Phase 12: curiosity sources its topics from the user's Tier-2 interest beliefs.
    userModel,
    llm: llmGateway,
    model: config.ingestionModel,
    logger: consoleLogger,
  });

  // Greeting on arrival (P14): the bond-driven reaction to the user returning.
  // Voiced greetings are interaction, so they spend STAMINA (the `quota` wallet),
  // not energy — an exhausted companion shows a fixed token-free line instead.
  const greeting = new GreetingService({
    identity,
    memory,
    proposals,
    rewards,
    userModel,
    stamina: quota,
    llm: llmGateway,
    model: config.ingestionModel,
    logger: consoleLogger,
  });

  // Growth (P5): four-axis growth DERIVED from substrate, with an idempotent
  // high-water mark. The service recomputes post-turn off the message stream (GET is
  // read-only). Decoupled from feeding — it stores nothing spendable.
  const growthStore = new DrizzleGrowthStore(db);
  // The feeding economy's supply: each user's seeded food pantry (companion-economy.md).
  const food = new DrizzleFoodStore(db, { initialFood: DEFAULT_GROWTH_CONFIG.initialFood });
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
    logger: consoleLogger,
  });

  const app = await buildApp({
    identity,
    userModel,
    memory,
    eventBus,
    eventLog,
    semantic,
    episodic,
    embeddings,
    staging,
    ingest,
    embodiment,
    consolidation,
    harness,
    tools,
    proposals,
    toolCallLog,
    leads,
    procedural,
    presence,
    motivation,
    greeting,
    quota,
    energy,
    food,
    rewards,
    reactions,
    reactionLearn,
    affect: affectStore,
    growth,
    growthStore,
    tokenVerifier: createTokenVerifier(config, db),
    config,
    logger: consoleLogger,
  });

  // Restart recovery: jobs interrupted mid-run lost their in-memory state, so
  // fail them (the user re-uploads); deferred jobs kept their parse and resume.
  const failed = await semantic.failInterruptedJobs();
  if (failed > 0) {
    consoleLogger.info('failed interrupted ingestion jobs on startup', { count: failed });
  }

  // Resume parked (deferred) jobs now and on a timer, so work that hit an empty
  // wallet drains as companions are fed (architecture.md §4.8). Enqueues an `ingest`
  // job per under-cap deferred source; the handler resumes from the held parse and
  // the pipeline re-checks the wallet, so it never overspends.
  const ingestionSweepDeps = { semantic, quota, ingest, logger: consoleLogger };
  await sweepIngestion(ingestionSweepDeps);
  const sweepTimer = setInterval(() => {
    void sweepIngestion(ingestionSweepDeps).catch((error: unknown) => {
      consoleLogger.error('deferred-ingestion sweep failed', { error });
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

  // Start draining the job queue: a bounded pool of ephemeral processors that
  // claim companions and run their due consolidate/motivation jobs, with a coarse
  // poll as the clock for idle / future-dated work (deliver-scalability.md §5.1).
  jobPool.start();

  // Graceful shutdown: stop the catch-up timers and drain in-flight background
  // work before exit so nothing is killed mid-write. Fastify runs onClose after
  // it has stopped accepting requests, so no new turns trigger work past here.
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    clearInterval(consolidationTimer);
    clearInterval(motivationTimer);
    await jobPool.close();
    await harness.whenIdle();
    await mcpGateway.close();
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

/**
 * Job-queue tuning (deliver-scalability.md §5.1.6). Lease is generous — longer
 * than any single background LLM pass — because it is renewed *between* jobs, not
 * mid-job. Poll is the coarse clock for idle/future work. Concurrency is the
 * per-node instantaneous cap (K), sized to resource ceilings, not population.
 */
const JOB_LEASE_MS = 5 * 60 * 1000;
const JOB_POLL_INTERVAL_MS = 30 * 1000;
const JOB_CONCURRENCY = 4;

main().catch((error: unknown) => {
  consoleLogger.error('api failed to start', { error });
  process.exitCode = 1;
});
