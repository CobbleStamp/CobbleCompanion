// Identity (the companion "home")
export {
  DrizzleIdentityStore,
  type CreateCompanionInput,
  type IdentityStore,
  type UserRecord,
} from './identity/store.js';
export { DrizzleAuthTokenStore, type AuthTokenStore } from './identity/auth-store.js';

// Memory
export { TranscriptMemoryStore, type MemoryStore } from './memory/store.js';

// LLM gateway
export {
  type LlmGateway,
  LlmGatewayError,
  type LlmMessage,
  type LlmStreamParams,
} from './llm/gateway.js';
export { OpenRouterGateway, type OpenRouterConfig } from './llm/openrouter.js';
export { FakeLlmGateway } from './llm/fake.js';

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

// Logging
export { consoleLogger, type Logger } from './logging.js';
