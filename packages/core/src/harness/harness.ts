import type { ChatStreamEvent, Citation, CompanionDto } from '@cobble/shared';
import type { LlmGateway, LlmMessage } from '../llm/gateway.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { MemoryStore } from '../memory/store.js';
import type { TokenQuotaStore } from '../quota/store.js';
import { dispatchTool } from '../tools/dispatch.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  addUsage,
  createUsageAccumulator,
  meteredLlmGateway,
  ZERO_USAGE,
  type TokenUsage,
} from '../usage.js';
import { assembleContext } from './context.js';
import {
  isBlock,
  passthroughAfterToolCall,
  passthroughBeforeToolCall,
  type AfterToolCall,
  type BeforeToolCall,
  type RetrieveContext,
  type TurnCtx,
} from './hooks.js';

/** Default ceiling on assistant turns per run — the dead-loop backstop (§4.7). */
const DEFAULT_MAX_TOOL_ITERATIONS = 6;

/** Shown when a run is cut off at a budget ceiling with no text yet (§4.7). */
const PARTIAL_FALLBACK =
  'I ran out of room to finish that just now — tell me how you’d like me to continue.';

export interface HarnessOptions {
  readonly gateway: LlmGateway;
  readonly memory: MemoryStore;
  readonly model: string;
  /** How many recent transcript messages to recall as context (P0 recency window). */
  readonly recentLimit?: number;
  readonly retrieveContext?: RetrieveContext;
  /** The tools available to a turn (P3). Empty/omitted reproduces the P0 path. */
  readonly registry?: ToolRegistry;
  /** Gate around every tool call — blocks effectful actions for approval (P3). */
  readonly beforeToolCall?: BeforeToolCall;
  /** Runs after each tool call — used to log every call (P3). */
  readonly afterToolCall?: AfterToolCall;
  /** Max assistant turns before exit-to-user-with-partial (dead-loop guard, §4.7). */
  readonly maxToolIterations?: number;
  /** Optional cumulative token ceiling per run — the second dead-loop guard (§4.7). */
  readonly turnTokenBudget?: number;
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
  private readonly registry: ToolRegistry;
  private readonly beforeToolCall: BeforeToolCall;
  private readonly afterToolCall: AfterToolCall;
  private readonly maxToolIterations: number;
  private readonly turnTokenBudget: number | undefined;
  private readonly quota: TokenQuotaStore | undefined;
  private readonly logger: Logger;

  constructor(options: HarnessOptions) {
    this.gateway = options.gateway;
    this.memory = options.memory;
    this.model = options.model;
    this.recentLimit = options.recentLimit ?? 20;
    this.logger = options.logger ?? consoleLogger;
    this.retrieveContext = options.retrieveContext ?? this.defaultRetrieveContext;
    this.registry = options.registry ?? new ToolRegistry();
    this.beforeToolCall = options.beforeToolCall ?? passthroughBeforeToolCall;
    this.afterToolCall = options.afterToolCall ?? passthroughAfterToolCall;
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.turnTokenBudget = options.turnTokenBudget;
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

      // Meter every LLM call in the run: the wrapper deposits each call's usage
      // into `acc`, so a multi-turn tool run is debited once, at exit.
      const acc = createUsageAccumulator();
      const llm = meteredLlmGateway(this.gateway, acc.sink);
      const ctx: TurnCtx = { companionId: companion.id, ownerId: ownerId ?? '' };
      const toolDefs = this.registry.list();

      // The inner loop (§4.1/§4.2): each turn streams, then either ends (no tool
      // calls) or runs the tools it requested and turns again. Two ceilings guard
      // a dead loop → exit-to-user-with-partial.
      let lastText = '';
      for (let iteration = 0; ; iteration++) {
        if (this.exhausted(iteration, acc.total())) {
          this.logger.error('turn hit its budget ceiling; exiting with partial', {
            operation: 'harness.runTurn',
            companionId: companion.id,
            iteration,
            tokens: acc.total().totalTokens,
          });
          yield* this.finish(companion.id, ownerId, lastText || PARTIAL_FALLBACK, retrievalUsage, acc);
          return;
        }

        let turnText = '';
        const stream = llm.stream({
          messages,
          model: this.model,
          ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
          ...(signal ? { signal } : {}),
        });
        let next = await stream.next();
        while (!next.done) {
          turnText += next.value;
          yield { type: 'token', value: next.value };
          next = await stream.next();
        }
        const { toolCalls } = next.value;
        lastText = turnText;

        // No tool calls → this is the assistant's answer; the run EXITs (§4.1).
        if (toolCalls.length === 0) {
          yield* this.finish(companion.id, ownerId, turnText, retrievalUsage, acc);
          return;
        }

        // The model wants tools. Replay its tool-call turn into the running
        // context so the provider can correlate the results we append next.
        messages.push({ role: 'assistant', content: turnText, toolCalls });

        for (const call of toolCalls) {
          const gated = await this.beforeToolCall(call, ctx);
          if (isBlock(gated)) {
            // Propose→approve: the action is held, not run. Record what the
            // companion said (or the proposal summary), surface the proposal, EXIT.
            const text = turnText.trim().length > 0 ? turnText : gated.proposal?.summary ?? gated.reason;
            if (gated.proposal) {
              yield { type: 'proposal', proposal: gated.proposal };
            }
            yield* this.finish(companion.id, ownerId, text, retrievalUsage, acc);
            return;
          }
          const result = await dispatchTool(
            this.registry,
            gated.name,
            gated.args,
            ctx,
            this.logger,
            call.id,
          );
          const logged = await this.afterToolCall(result, ctx);
          messages.push({
            role: 'tool',
            content: logged.content,
            ...(call.id !== undefined ? { toolCallId: call.id } : {}),
          });
        }
      }
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

  /** Has the run hit either dead-loop ceiling (iteration count or token budget)? */
  private exhausted(iteration: number, used: TokenUsage): boolean {
    if (iteration >= this.maxToolIterations) return true;
    return this.turnTokenBudget !== undefined && used.totalTokens >= this.turnTokenBudget;
  }

  /** Persist the assistant turn, debit the run's tokens once, and emit `done`. */
  private async *finish(
    companionId: string,
    ownerId: string | undefined,
    text: string,
    retrievalUsage: TokenUsage,
    acc: ReturnType<typeof createUsageAccumulator>,
  ): AsyncGenerator<ChatStreamEvent> {
    const message = await this.memory.appendMessage(companionId, 'assistant', text);
    await this.debit(ownerId, addUsage(retrievalUsage, acc.total()));
    yield { type: 'done', message };
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
