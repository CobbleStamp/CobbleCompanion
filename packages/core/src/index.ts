// Tools (P3 — the companion's hands; the gate decides which run freely)
export { type Tool, toToolDef, toolErrorMessage } from './tools/tool.js';
export { ToolRegistry } from './tools/registry.js';
export { dispatchTool } from './tools/dispatch.js';
export {
  DrizzleProposalStore,
  toProposalDto,
  type CreateProposalInput,
  type ProposalRecord,
  type ProposalStore,
} from './tools/proposal-store.js';
export {
  DrizzleToolCallLog,
  type ToolCallLog,
  type ToolCallRecord,
  type ToolCallStats,
} from './tools/tool-call-log.js';
export { createApprovalGate, createLoggingAfterToolCall } from './tools/gate.js';
export { DrizzleLeadStore, type LeadRecord, type LeadStore } from './tools/lead-store.js';
export {
  DrizzleProceduralStore,
  type ProceduralStore,
  type ProcedureRecord,
} from './tools/procedural-store.js';
export { createWebFetchTool, type WebFetchOptions } from './tools/web-fetch.js';
export {
  createMemorySearchTool,
  type MemorySearchOptions,
  type SemanticSearchPort,
} from './tools/memory-search.js';
export {
  createIngestSourceTool,
  type IngestSourceOptions,
  type IngestionEnqueuePort,
  type SourceRegistrationPort,
} from './tools/ingest-source.js';

// MCP tool acquisition (companion-tools.md — Phase 9): a whitelisted catalog the
// companion discovers (search_tools) and loads from (load_tool) on demand, with a
// per-step registry over the equipped set.
export {
  McpGatewayError,
  type McpCallResult,
  type McpGateway,
  type McpServerSpec,
  type McpToolDef,
} from './mcp/gateway.js';
export { mcpToolName, mcpToolToTool, type McpToolAdapterOptions } from './mcp/adapter.js';
export { FakeMcpGateway, type FakeMcpCall, type FakeMcpServer } from './mcp/fake.js';
export { McpWhitelist, type McpWhitelistEntry } from './mcp/whitelist.js';
export { createMcpCapabilitySource, type McpCapabilitySourceOptions } from './mcp/mcp-source.js';
// The source-agnostic acquisition spine (companion-tools.md §8): a CapabilitySource
// abstracts where a tool comes from (MCP servers, host CLIs) behind the catalog +
// equipped set + per-step registry, so sources compose without knowing each other.
export {
  type CapabilitySource,
  type CatalogContribution,
  indexCapabilitySources,
} from './acquisition/capability-source.js';
export {
  DrizzleToolCatalogStore,
  type ToolCatalogEntry,
  type ToolCatalogStore,
} from './acquisition/tool-catalog-store.js';
export {
  DrizzleEquippedToolStore,
  type EquipInput,
  type EquippedStoreOptions,
  type EquippedToolRecord,
  type EquippedToolStore,
} from './acquisition/equipped-store.js';
export { refreshToolCatalog, type RefreshCatalogOptions } from './acquisition/catalog-builder.js';
export { createSearchToolsTool, type SearchToolsOptions } from './acquisition/search-tools.js';
export { createLoadToolTool, type LoadToolOptions } from './acquisition/load-tool.js';
export {
  createToolLoadAdvisor,
  type ToolLoadAdvisor,
  type ToolLoadAdvisorOptions,
} from './acquisition/load-advisor.js';
export {
  createEquippedRegistryResolver,
  type EquippedRegistryResolverOptions,
} from './acquisition/equipped-resolver.js';
// CLI tool acquisition (companion-tools.md — Phase 10): host CLIs as a second
// capability source over the same spine; run_command is the sandboxed executor.
export {
  type CommandRequest,
  type CommandResult,
  type CommandSandbox,
  FakeCommandSandbox,
} from './cli/sandbox.js';
export {
  type CliToolDef,
  type CliToolLimits,
  parseCliToolDef,
  unsafeArgvPlaceholders,
} from './cli/tool-def.js';
export {
  type CliToolAdapterOptions,
  cliToolName,
  cliToolToTool,
  runCliTool,
} from './cli/adapter.js';
export { type CliToolStore, InMemoryCliToolStore } from './cli/tool-store.js';
export { type CliCapabilitySourceOptions, createCliCapabilitySource } from './cli/cli-source.js';

// Identity (the companion "home")
export {
  DrizzleIdentityStore,
  type CompanionRecord,
  type CreateCompanionInput,
  type DrizzleIdentityStoreOptions,
  type IdentityStore,
  type UserClaim,
  type UserRecord,
} from './identity/store.js';
export { DrizzleServiceRegistry, type ServiceRegistry } from './identity/service-registry.js';

// User Model (Phase 11 — core profile; Phase 12 — learned beliefs)
export {
  type BeliefHit,
  type BeliefSearchParams,
  DrizzleUserModelStore,
  type RecordBeliefInput,
  type RecordTranscriptFactInput,
  type UserModelStore,
} from './user-model/store.js';
export {
  captureUserFacts,
  coerceCandidates,
  type UserFactCandidate,
  type UserFactCaptureDeps,
  type UserFactCaptureParams,
} from './user-model/extractor.js';
export { beliefPhrase } from './user-model/phrasing.js';
export {
  coerceBeliefs,
  coerceDecisions,
  LlmUserModelReflector,
  type UserModelReflector,
  type UserModelReflectorOptions,
} from './user-model/reflector.js';
export {
  LlmUserPersonaSynthesizer,
  type UserPersonaSynthesizer,
  type UserPersonaSynthesizerOptions,
} from './user-model/synthesize.js';
export {
  effectiveSalience,
  isStale,
  BELIEF_SALIENCE_HALF_LIFE_DAYS,
  STALE_SALIENCE_FLOOR,
} from './user-model/decay.js';
export {
  isSensitiveMatter,
  isGatedSensitive,
  SENSITIVE_MATTERS,
  SENSITIVE_WRITE_CONFIDENCE,
} from './user-model/sensitive.js';

// Memory
export { TranscriptMemoryStore, type MemoryStore, type TranscriptEntry } from './memory/store.js';
export { PublishingMemoryStore } from './memory/publishing-store.js';

// Event channel (architecture.md §6) — the standing companion event channel's substrate
export {
  InProcessCompanionEventBus,
  type CompanionEventBus,
  type CompanionSubscription,
} from './events/bus.js';
export {
  consolidateWindow,
  parseEpisodes,
  type ConsolidationCandidate,
  type PersonaSummary,
} from './memory/consolidation.js';
export { ConsolidationRunner, type ConsolidationTarget } from './memory/consolidation-runner.js';
export {
  ConsolidationService,
  sweepConsolidation,
  type ConsolidationServiceOptions,
  type ConsolidationSweepDeps,
} from './memory/consolidation-service.js';
export { reciprocalRankFusion, RRF_K } from './memory/rrf.js';
export {
  combineHits,
  DrizzleSemanticMemoryStore,
  type CreateSourceInput,
  type DeferredJob,
  type JobPatch,
  type JobRecord,
  type NewFact,
  type NewSection,
  type SectionRecord,
  type SemanticCounts,
  type SemanticMemoryStore,
  type SemanticSearchHit,
  type SemanticSearchParams,
  type SourceRecord,
} from './memory/semantic-store.js';
export {
  DrizzleEpisodicMemoryStore,
  type EpisodeRecord,
  type EpisodeSearchHit,
  type EpisodeSearchParams,
  type EpisodicMemoryStore,
  type NewEpisode,
} from './memory/episodic-store.js';

// LLM gateway
export {
  type LlmGateway,
  LlmGatewayError,
  type LlmMessage,
  type LlmStreamParams,
  type StreamResult,
  type ToolCall,
  type ToolDef,
} from './llm/gateway.js';
export { OpenRouterGateway, type OpenRouterConfig } from './llm/openrouter.js';
export { FakeLlmGateway, type FakeTurn } from './llm/fake.js';

// Prompt registry (code-as-truth, versioned prompts — guide-prompts.md)
export {
  type PromptBuild,
  type PromptEntry,
  type PromptId,
  type PromptRef,
  type PromptTemplate,
  type PromptVersion,
  type RenderedPrompt,
  contentHash,
  getPromptEntry,
  judgeTemplate,
  type JudgeInput,
  listPrompts,
  render,
  versionOf,
} from './prompts/index.js';

// Tracing seam (online observability — runbook-tracing.md). The Langfuse adapter
// lives in the api package; core exposes only the interface, redaction, sampling.
export {
  guardedTraceSink,
  noopTraceSink,
  type RedactionMode,
  scrubContent,
  scrubError,
  shouldSample,
  type SpanEnd,
  type SpanHandle,
  type SpanKind,
  type SpanStart,
  type TraceAttributes,
  type TraceContent,
  type TraceHandle,
  type TraceSink,
  type TraceStart,
} from './tracing/index.js';

// Embedding gateway
export {
  type EmbeddingGateway,
  EmbeddingGatewayError,
  type EmbeddingParams,
  type EmbeddingResult,
} from './embedding/gateway.js';

// Vitality wallets — the per-companion stamina + energy balances, two columns on the
// companions row (architecture.md §4.8). One store implementation meters both, picked
// by `kind`; also the generic metering contract the ingestion pipeline bills through.
export {
  CompanionNotFoundError,
  DrizzleVitalityStore,
  type VitalityKind,
  type VitalityStore,
} from './quota/vitality-store.js';

// Food pantry — the per-user supply the feeding economy spends (companion-economy.md).
export {
  type FoodInventory,
  type FoodStore,
  DrizzleFoodStore,
  type DrizzleFoodStoreOptions,
} from './growth/food-store.js';

// Motivation engine — presence (Phase 4)
export {
  classifyPresence,
  DEFAULT_PRESENCE_THRESHOLDS,
  PRESENCE_POSTURE,
  type PresencePosture,
  type PresenceSignal,
  type PresenceState,
  type PresenceThresholds,
  presencePosture,
} from './motivation/presence.js';
export { InMemoryPresenceStore, type PresenceStore } from './motivation/presence-store.js';
// Motivation engine — drives, arbitration, explore burst, the engine (Phase 4)
export {
  computeDrives,
  DEFAULT_DRIVE_WEIGHTS,
  DRIVES,
  type DriveContext,
  type DriveLevels,
  NEUTRAL_WEIGHT,
  resolveWeights,
} from './motivation/drives.js';
export {
  type ArbitrationInput,
  DEFAULT_KNOBS,
  decideMove,
  type ExploreMove,
  type Move,
} from './motivation/arbitration.js';
export {
  DEFAULT_EXPLORE_BURST,
  type ExploreBurstDeps,
  type ExploreBurstParams,
  runExploreBurst,
} from './motivation/explore-burst.js';
export {
  MotivationEngine,
  type MotivationEngineDeps,
  type MotivationEngineOptions,
  type MotivationTickResult,
} from './motivation/engine.js';
export {
  type AutonomousBurstDeps,
  type AutonomousBurstParams,
  type AutonomousBurstResult,
  type AutonomousIngestStore,
  type CompanionVoice,
  runAutonomousBurst,
} from './motivation/autonomous-burst.js';
export { MotivationRunner, type MotivationTarget } from './motivation/engine-runner.js';
export { type MotivationSweepDeps, sweepMotivation } from './motivation/engine-sweep.js';
// Greeting on arrival (Phase 14) — the bond-driven reaction to the user returning.
export {
  decideGreeting,
  type GreetingDecisionInput,
  type GreetingKind,
  type GreetingMove,
  CONTINUATION_FLOOR_MS,
  ACTIVE_GAP_MS,
  GENTLE_GAP_MS,
} from './greeting/decide.js';
export {
  GreetingService,
  type GreetingServiceDeps,
  type GreetingServiceOptions,
  type GreetingPlan,
} from './greeting/greeter.js';
// Reinforcement — outcome store, change-as-reward weight update, attribution (Phase 4)
export {
  DrizzleProactiveOutcomeStore,
  type ProactiveOutcomeBelief,
  type ProactiveOutcomeDetail,
  type ProactiveOutcomeRecord,
  type ProactiveOutcomeStats,
  type ProactiveOutcomeStore,
  type RecordOutcomeInput,
} from './motivation/reward-store.js';
export {
  DrizzleReactionStore,
  type AddReactionResult,
  type ReactionRecord,
  type ReactionStore,
} from './reactions/store.js';
export {
  senseReaction,
  coerceReactionReading,
  type ReactionReading,
  type ReactionSenseDeps,
  type ReactionSenseParams,
} from './reactions/sense.js';
export { ReactionLearner, type ReactionLearnerDeps } from './reactions/learner.js';
export { asReactableMessage, type ReactableMessage } from './reactions/reactable.js';
export { createReactTool, type ReactToolOptions } from './reactions/react-tool.js';
export {
  DEFAULT_LEARNING_RATE,
  nudgeDriveWeight,
  WEIGHT_CEILING,
  WEIGHT_FLOOR,
} from './motivation/weights.js';
// Reinforcement (Phase 4.2) — the will's half: attribute the mood change to the
// pending drive-serving act and nudge that drive's weight.
export { reinforceFromDelta, type ReinforceDeps } from './motivation/reinforce.js';
// Affect perception (Phase 4.2) — the rolling read of the user's mood, sensed
// every turn in the agent loop; drives attunement (fast loop) + reward (slow loop).
export {
  type AffectReading,
  type AffectSenseDeps,
  type AffectSenseParams,
  coerceReading,
  NEUTRAL_AFFECT,
  senseAffect,
} from './motivation/affect.js';
export {
  type CompanionAffectStore,
  DrizzleCompanionAffectStore,
} from './motivation/affect-store.js';

// Token usage / metering (vitality wallets, architecture.md §4.8)
export {
  addUsage,
  createUsageAccumulator,
  estimateTokens,
  estimateUsage,
  meteredLlmGateway,
  ZERO_USAGE,
  type TokenUsage,
  type UsageAccumulator,
  type UsageSink,
} from './usage.js';
export {
  OpenRouterEmbeddingGateway,
  type OpenRouterEmbeddingConfig,
} from './embedding/openrouter.js';
export { FakeEmbeddingGateway, hashToUnitVector } from './embedding/fake.js';
export { createMemoizingEmbeddingGateway } from './embedding/memoizing.js';

// Harness (the agent loop)
export {
  Harness,
  type HarnessAffect,
  type HarnessOptions,
  type RunTurnParams,
} from './harness/harness.js';
export { assembleContext, buildPersona } from './harness/context.js';
export {
  createSemanticRetrieveContext,
  type SemanticRetrieveOptions,
} from './harness/semantic-retrieve.js';
export {
  createEpisodicRetrieveContext,
  toEpisodeBlock,
  type EpisodicRetrieveOptions,
} from './harness/episodic-retrieve.js';
export { composeRetrieveContext } from './harness/compose-retrieve.js';
export {
  createProceduralRetrieveContext,
  type ProceduralRetrieveOptions,
} from './harness/procedural-retrieve.js';
export {
  createUserModelRetrieveContext,
  toBeliefsBlock,
  type UserModelRetrieveOptions,
} from './harness/user-model-retrieve.js';
export {
  createEquippedSummaryContext,
  type EquippedSummaryOptions,
} from './acquisition/equipped-summary.js';

// Growth & feeding economy (Phase 5 — bond & growth, development-plan.md §3)
export { DEFAULT_GROWTH_CONFIG, type GrowthConfig } from './growth/config.js';
export { type GrowthSubstrate } from './growth/substrate.js';
export {
  type AxisReading,
  bondPoints,
  computeBondReading,
  computeCharacterReading,
  computeInitiativeReading,
  computeKnowledgeReading,
  knowledgePoints,
  personalitySpread,
} from './growth/levels.js';
export {
  CAPABILITIES,
  capabilityChecklist,
  capabilityLabel,
  computeObserved,
} from './growth/capabilities.js';
export {
  DrizzleGrowthStore,
  type DrizzleGrowthStoreOptions,
  type GrowthSnapshot,
  type GrowthStore,
  type GrowthTarget,
} from './growth/growth-store.js';
export { GrowthService, type GrowthServiceDeps, type GrowthTransition } from './growth/service.js';
export { feed, type FeedDeps, type FeedParams, type FeedResult } from './growth/economy.js';

// Personality evolution (Phase 2)
export {
  LlmPersonalityEvolver,
  type PersonalityEvolver,
  type PersonalityEvolverOptions,
} from './personality/evolve.js';
export {
  idleInitiator,
  isBlock,
  passthroughAfterToolCall,
  passthroughBeforeToolCall,
  type AfterToolCall,
  type BeforeToolCall,
  type Block,
  type ContextBlock,
  type Entry,
  type Initiator,
  type RetrieveContext,
  type RetrieveParams,
  type ToolResult,
  type TurnCtx,
} from './harness/hooks.js';

// Ingestion (Phase 1: parse → segment → enrich → embed)
export {
  parseLinkHtml,
  parseNote,
  parsePdf,
  type ParsedDocument,
  type Paragraph,
} from './ingestion/parser.js';
export { segmentParagraphs, type SectionBoundary } from './ingestion/segmenter.js';
export { enrichSection, type Enrichment, type ExtractedFact } from './ingestion/enricher.js';
export { buildEmbeddingInput } from './ingestion/embedder.js';
export { CORE_FACT_TYPES, isCoreFactType, type CoreFactType } from './ingestion/ontology.js';
export { assertPublicHttpUrl } from './ingestion/url-guard.js';
export { ssrfSafeFetch } from './ingestion/safe-fetch.js';
export {
  parseContent,
  contentTypeForUploadKind,
  contentTypeFromMime,
  looksBinary,
  sniffContentType,
  type ContentType,
  type RawContent,
} from './ingestion/content-parser.js';
export {
  createSourceParser,
  type SourceParser,
  type SourceParserOptions,
} from './ingestion/source-parser.js';
export {
  createHttpLinkResolver,
  detectContentType,
  type LinkResolver,
  type HttpLinkResolverOptions,
} from './ingestion/link-resolver.js';
export {
  IngestionQueueFullError,
  IngestionRunner,
  type IngestionTarget,
} from './ingestion/runner.js';
export {
  IngestionPipeline,
  type IngestionPayload,
  type IngestionPipelineOptions,
  type IngestionRunParams,
} from './ingestion/pipeline.js';
export {
  LlmIngestionAnnouncer,
  type IngestionAnnouncer,
  type IngestionOutcome,
  type LlmIngestionAnnouncerOptions,
} from './ingestion/announcer.js';
export { resumeDeferredJobs, type DeferredSweepDeps } from './ingestion/deferred-sweeper.js';

// Logging
export { consoleLogger, type Logger } from './logging.js';
