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
} from './llm/gateway.js';
export { OpenRouterGateway, type OpenRouterConfig } from './llm/openrouter.js';
export { FakeLlmGateway } from './llm/fake.js';

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
  type ToolCall,
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
