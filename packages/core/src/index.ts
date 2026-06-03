// Identity (the companion "home")
export {
  DrizzleIdentityStore,
  type CreateCompanionInput,
  type IdentityStore,
  type UserRecord,
} from './identity/store.js';

// Memory
export { TranscriptMemoryStore, type MemoryStore } from './memory/store.js';
export {
  combineHits,
  DrizzleSemanticMemoryStore,
  type CreateSourceInput,
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
} from './embedding/gateway.js';
export {
  OpenRouterEmbeddingGateway,
  type OpenRouterEmbeddingConfig,
} from './embedding/openrouter.js';
export { FakeEmbeddingGateway, hashToUnitVector } from './embedding/fake.js';

// Harness (the agent loop)
export { Harness, type HarnessOptions, type RunTurnParams } from './harness/harness.js';
export { assembleContext, buildPersona } from './harness/context.js';
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
export { IngestionRunner, type IngestionTarget } from './ingestion/runner.js';
export {
  IngestionPipeline,
  type IngestionPayload,
  type IngestionPipelineOptions,
  type IngestionRunParams,
} from './ingestion/pipeline.js';

// Logging
export { consoleLogger, type Logger } from './logging.js';
