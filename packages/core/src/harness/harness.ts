import type { ChatStreamEvent, Citation, CompanionDto } from '@cobble/shared';
import type { LlmGateway } from '../llm/gateway.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import type { TokenQuotaStore } from '../quota/store.js';
import {
  addUsage,
  createUsageAccumulator,
  meteredLlmGateway,
  ZERO_USAGE,
  type TokenUsage,
} from '../usage.js';
import { assembleContext } from './context.js';
import type { RetrieveContext } from './hooks.js';

export interface HarnessOptions {
  readonly gateway: LlmGateway;
  readonly memory: MemoryStore;
  readonly model: string;
  /** How many recent transcript messages to recall as context (P0 recency window). */
  readonly recentLimit?: number;
  readonly retrieveContext?: RetrieveContext;
  /** Debits the turn's tokens against the owner's daily cap; omitted = no metering. */
  readonly quota?: TokenQuotaStore;
  readonly logger?: Logger;
}

export interface RunTurnParams {
  readonly companion: CompanionDto;
  readonly userContent: string;
  /** The companion's owner — the account the turn's tokens are debited to. */
  readonly ownerId?: string;
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
  private readonly quota?: TokenQuotaStore;
  private readonly logger: Logger;

  constructor(options: HarnessOptions) {
    this.gateway = options.gateway;
    this.memory = options.memory;
    this.model = options.model;
    this.recentLimit = options.recentLimit ?? 20;
    this.logger = options.logger ?? consoleLogger;
    this.retrieveContext = options.retrieveContext ?? this.defaultRetrieveContext;
    this.quota = options.quota;
  }

  /**
   * Run one ENTRY through the loop, streaming the assistant turn as events. The
   * user message is persisted on entry; the assistant message on exit (the
   * transcript is the source of truth, §4.7).
   */
  async *runTurn(params: RunTurnParams): AsyncGenerator<ChatStreamEvent> {
    const { companion, userContent, ownerId, signal } = params;
    try {
      await this.memory.appendMessage(companion.id, 'user', userContent);

      const { blocks: history, usage: retrievalUsage } = await this.retrieveContext({
        companionId: companion.id,
        userContent,
      });
      const messages = assembleContext(companion, history);

      // Citations are retrieval-time data: surface the grounding sources as
      // soon as they are known, before (and independent of) the token stream.
      const citations = dedupeCitations(history.flatMap((block) => block.provenance ?? []));
      if (citations.length > 0) {
        yield { type: 'citations', citations };
      }

      // Meter the LLM call: the wrapper deposits its token usage into `acc` once
      // the stream completes, without disturbing the token relay.
      const acc = createUsageAccumulator();
      const llm = meteredLlmGateway(this.gateway, acc.sink);
      let assistantText = '';
      for await (const delta of llm.stream({
        messages,
        model: this.model,
        ...(signal ? { signal } : {}),
      })) {
        assistantText += delta;
        yield { type: 'token', value: delta };
      }

      const message = await this.memory.appendMessage(companion.id, 'assistant', assistantText);
      await this.debit(ownerId, addUsage(retrievalUsage, acc.total()));
      yield { type: 'done', message };
    } catch (error) {
      // Failures are data: log with context, then surface a terminal error event.
      this.logger.error('turn failed', {
        operation: 'harness.runTurn',
        companionId: companion.id,
        error,
      });
      yield {
        type: 'error',
        message: 'Cobble hit a problem while responding. Please try again.',
      };
    }
  }

  /**
   * Debit the turn's tokens against the owner's daily cap. Best-effort: a
   * metering failure is logged but never breaks the conversation (logging.md),
   * and turns with no owner/quota (e.g. tests) simply skip metering.
   */
  private async debit(ownerId: string | undefined, usage: TokenUsage): Promise<void> {
    if (!this.quota || !ownerId || usage.totalTokens <= 0) {
      return;
    }
    try {
      await this.quota.recordUsage(ownerId, usage.totalTokens);
    } catch (error) {
      this.logger.error('failed to record chat token usage', {
        operation: 'harness.debit',
        ownerId,
        error,
      });
    }
  }

  private defaultRetrieveContext: RetrieveContext = async ({ companionId }) => {
    const recent = await this.memory.getRecentMessages(companionId, this.recentLimit);
    return {
      blocks: recent.map((message) => ({ role: message.role, content: message.content })),
      usage: ZERO_USAGE,
    };
  };
}

/** Collapse repeated passages from the same source span into one citation. */
function dedupeCitations(citations: readonly Citation[]): readonly Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.sourceId}:${citation.paraStart}-${citation.paraEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
