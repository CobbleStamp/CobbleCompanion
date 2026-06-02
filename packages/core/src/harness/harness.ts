import type { ChatStreamEvent, CompanionDto } from '@cobble/shared';
import type { LlmGateway } from '../llm/gateway.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import { assembleContext } from './context.js';
import type { ContextBlock, RetrieveContext } from './hooks.js';

export interface HarnessOptions {
  readonly gateway: LlmGateway;
  readonly memory: MemoryStore;
  readonly model: string;
  /** How many recent transcript messages to recall as context (P0 recency window). */
  readonly recentLimit?: number;
  readonly retrieveContext?: RetrieveContext;
  readonly logger?: Logger;
}

export interface RunTurnParams {
  readonly companion: CompanionDto;
  readonly conversationId: string;
  readonly userContent: string;
  readonly signal?: AbortSignal;
}

/**
 * The agent loop (architecture.md §4). Phase 0 exercises only the trivial path:
 * the tool set is empty, so the inner loop turns exactly once — context → one
 * streamed LLM call → EXIT → persist (§4.6). The loop shape is an invariant; tool
 * iteration (P3) and proactive entry (P4) are additive.
 */
export class Harness {
  private readonly gateway: LlmGateway;
  private readonly memory: MemoryStore;
  private readonly model: string;
  private readonly recentLimit: number;
  private readonly retrieveContext: RetrieveContext;
  private readonly logger: Logger;

  constructor(options: HarnessOptions) {
    this.gateway = options.gateway;
    this.memory = options.memory;
    this.model = options.model;
    this.recentLimit = options.recentLimit ?? 20;
    this.logger = options.logger ?? consoleLogger;
    this.retrieveContext = options.retrieveContext ?? this.defaultRetrieveContext;
  }

  /**
   * Run one ENTRY through the loop, streaming the assistant turn as events. The
   * user message is persisted on entry; the assistant message on exit (the
   * transcript is the source of truth, §4.7).
   */
  async *runTurn(params: RunTurnParams): AsyncGenerator<ChatStreamEvent> {
    const { companion, conversationId, userContent, signal } = params;
    try {
      await this.memory.appendMessage(conversationId, 'user', userContent);

      const history = await this.retrieveContext(companion.id, conversationId);
      const messages = assembleContext(companion, history);

      let assistantText = '';
      for await (const delta of this.gateway.stream({
        messages,
        model: this.model,
        ...(signal ? { signal } : {}),
      })) {
        assistantText += delta;
        yield { type: 'token', value: delta };
      }

      const message = await this.memory.appendMessage(conversationId, 'assistant', assistantText);
      yield { type: 'done', message };
    } catch (error) {
      // Failures are data: log with context, then surface a terminal error event.
      this.logger.error('turn failed', {
        operation: 'harness.runTurn',
        companionId: companion.id,
        conversationId,
        error,
      });
      yield {
        type: 'error',
        message: 'Cobble hit a problem while responding. Please try again.',
      };
    }
  }

  private defaultRetrieveContext: RetrieveContext = async (
    _companionId,
    conversationId,
  ): Promise<readonly ContextBlock[]> => {
    const recent = await this.memory.getRecentMessages(conversationId, this.recentLimit);
    return recent.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  };
}
