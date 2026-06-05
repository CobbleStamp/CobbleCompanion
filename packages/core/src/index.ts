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

// Identity (the companion "home")
export {
  DrizzleIdentityStore,
  type CompanionRecord,
  type CreateCompanionInput,
  type IdentityStore,
  type UserRecord,
} from './identity/store.js';

// Memory
export { TranscriptMemoryStore, type MemoryStore, type TranscriptEntry } from './memory/store.js';
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

// Embedding gateway
export {
  type EmbeddingGateway,
  EmbeddingGatewayError,
  type EmbeddingParams,
  type EmbeddingResult,
} from './embedding/gateway.js';

// Token quota (per-user daily cap state)
export {
  DrizzleTokenQuotaStore,
  type DrizzleTokenQuotaStoreOptions,
  type TokenQuotaStore,
  type UsageSnapshot,
} from './quota/store.js';

// Companion energy (per-companion self-initiated pool — the motivation engine's fuel, Phase 4)
export {
  type CompanionEnergyStore,
  DrizzleCompanionEnergyStore,
  type DrizzleCompanionEnergyStoreOptions,
  type EnergySnapshot,
} from './quota/energy-store.js';
export { EnergyQuotaAdapter } from './quota/energy-quota-adapter.js';

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
// Reinforcement v1 — outcome store, EMA weight update, reward attribution (Phase 4)
export {
  DrizzleProactiveOutcomeStore,
  type ProactiveOutcomeRecord,
  type ProactiveOutcomeStore,
  type RecordOutcomeInput,
} from './motivation/reward-store.js';
export {
  DEFAULT_LEARNING_RATE,
  updateDriveWeights,
  WEIGHT_CEILING,
  WEIGHT_FLOOR,
} from './motivation/weights.js';
export {
  applyConversationReward,
  type ConversationRewardDeps,
  MIN_REWARD_TO_LEARN,
  parseValence,
} from './motivation/sentiment-reward.js';
// Affect perception (Phase 4.2) — the rolling read of the user's mood, sensed
// every turn in the agent loop; drives attunement (fast loop) + reward (slow loop).
export {
  type AffectReading,
  type AffectSenseDeps,
  type AffectSenseParams,
  NEUTRAL_AFFECT,
  parseAffect,
  senseAffect,
} from './motivation/affect.js';
export {
  type CompanionAffectStore,
  DrizzleCompanionAffectStore,
} from './motivation/affect-store.js';

// Token usage / metering (per-user daily cap)
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
export { Harness, type HarnessOptions, type RunTurnParams } from './harness/harness.js';
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
