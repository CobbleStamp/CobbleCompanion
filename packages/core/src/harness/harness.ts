import type {
  ChatStreamEvent,
  Citation,
  CompanionDto,
  MessageDto,
  ProposalDto,
} from '@cobble/shared';
import type { LlmGateway, LlmMessage } from '../llm/gateway.js';
import { toolStepSummary } from '../tools/tool.js';
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

/** Last-ditch text for a held turn that spoke no pre-amble and carried no reason. */
const HELD_TURN_FALLBACK = 'I’ve set that aside for you to confirm.';

/** User-facing text when a turn can't be completed (failures are data, §4.7). */
const TURN_ERROR_MESSAGE = 'Cobble hit a problem while responding. Please try again.';

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

/** Resume after an approved action (continueAfterApproval). */
export interface ContinueParams {
  readonly companion: CompanionDto;
  readonly ownerId?: string;
  /** The completed action's result line, injected so the model knows it's done. */
  readonly outcome: string;
  readonly signal?: AbortSignal;
}

/** The assembled prompt + retrieval results shared by both loop entry points. */
interface PreparedTurn {
  readonly messages: LlmMessage[];
  readonly citations: readonly Citation[];
  readonly retrievalUsage: TokenUsage;
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
      const prep = await this.prepare(companion, userContent);
      yield* this.runLoop(companion, ownerId, prep, signal);
    } catch (error) {
      yield this.failed(companion.id, error);
    }
  }

  /**
   * Resume the conversation after the user approves a held action. No new user
   * message is persisted — the approval is the ENTRY. The recency window carries
   * the original request and the companion's pre-amble; an ephemeral note tells
   * the model the action just completed (the persisted `tool_step` row is the UI
   * record, but it's filtered out of context), so the model narrates the outcome
   * and continues whatever was asked ("…then summarize what you saved").
   */
  async *continueAfterApproval(params: ContinueParams): AsyncGenerator<ChatStreamEvent> {
    const { companion, ownerId, outcome, signal } = params;
    try {
      const prep = await this.prepare(companion, '');
      prep.messages.push({
        role: 'user',
        content:
          `[Your proposed action was approved and has completed: ${outcome} ` +
          `Continue with what the user asked — do not propose it again.]`,
      });
      yield* this.runLoop(companion, ownerId, prep, signal);
    } catch (error) {
      yield this.failed(companion.id, error);
    }
  }

  /** Retrieve context, assemble the prompt, and collect the turn's citations. */
  private async prepare(companion: CompanionDto, userContent: string): Promise<PreparedTurn> {
    const { blocks: history, usage: retrievalUsage } = await this.retrieveContext({
      companionId: companion.id,
      userContent,
    });
    const messages = assembleContext(companion, history);
    const citations = dedupeCitations(history.flatMap((block) => block.provenance ?? []));
    return { messages, citations, retrievalUsage };
  }

  /**
   * The inner loop (§4.1/§4.2): each turn streams, then either ends (no tool
   * calls) or runs the tools it requested and turns again. Read-only calls run
   * and are recorded as `tool_step` rows; effectful calls are held as proposals
   * and the run EXITs for approval. Two ceilings guard a dead loop → exit-to-
   * user-with-partial.
   */
  private async *runLoop(
    companion: CompanionDto,
    ownerId: string | undefined,
    prep: PreparedTurn,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatStreamEvent> {
    const { messages, citations, retrievalUsage } = prep;
    // Citations are retrieval-time data: surface the grounding sources as soon
    // as they are known, before (and independent of) the token stream.
    if (citations.length > 0) {
      yield { type: 'citations', citations };
    }

    // Meter every LLM call in the run: the wrapper deposits each call's usage
    // into `acc`, so a multi-turn tool run is debited once, at exit.
    const acc = createUsageAccumulator();
    const llm = meteredLlmGateway(this.gateway, acc.sink);
    const ctx: TurnCtx = { companionId: companion.id, ownerId: ownerId ?? '' };
    const toolDefs = this.registry.list();

    let lastText = '';
    for (let iteration = 0; ; iteration++) {
      if (this.exhausted(iteration, acc.total())) {
        this.logger.error('turn hit its budget ceiling; exiting with partial', {
          operation: 'harness.runLoop',
          companionId: companion.id,
          iteration,
          tokens: acc.total().totalTokens,
        });
        yield* this.finish(
          companion.id,
          ownerId,
          lastText || PARTIAL_FALLBACK,
          citations,
          retrievalUsage,
          acc,
        );
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
        yield* this.finish(companion.id, ownerId, turnText, citations, retrievalUsage, acc);
        return;
      }

      // The model wants tools. Replay its tool-call turn into the running
      // context so the provider can correlate the results we append next.
      messages.push({ role: 'assistant', content: turnText, toolCalls });

      // Walk EVERY requested call. Read-only calls run now; each effectful call
      // is held as its own proposal. We collect all held proposals across the
      // turn instead of bailing on the first — otherwise a turn that asks to
      // remember two sources (or to remember one and look up another) would
      // silently drop everything after the first blocked call. Nothing effectful
      // runs here regardless; held actions wait for approval.
      const heldProposals: ProposalDto[] = [];
      let blocked = false;
      let blockReason = '';
      for (const call of toolCalls) {
        const gated = await this.beforeToolCall(call, ctx);
        if (isBlock(gated)) {
          blocked = true;
          if (gated.proposal) {
            heldProposals.push(gated.proposal);
          } else if (blockReason === '') {
            blockReason = gated.reason;
          }
          continue;
        }
        const result = await dispatchTool(
          this.registry,
          gated.name,
          gated.args,
          ctx,
          this.logger,
          call.id,
        );
        const logged = await this.afterToolCall(result, gated, ctx);
        messages.push({
          role: 'tool',
          content: logged.content,
          ...(call.id !== undefined ? { toolCallId: call.id } : {}),
        });
        // Record a friendly one-line transcript row for the look-up so the
        // conversation shows what the companion did (UI-only; filtered out of
        // the model's context). Best-effort — see recordToolStep.
        yield* this.recordToolStep(companion.id, gated.name, gated.args);
      }

      // Any held action means the run pauses for approval: persist the pre-amble
      // and each proposal row (so they survive reload), surface the proposals,
      // and EXIT. Approving re-enters via continueAfterApproval (confirm route).
      if (blocked) {
        yield* this.finishBlocked(
          companion.id,
          ownerId,
          turnText,
          heldProposals,
          blockReason,
          citations,
          retrievalUsage,
          acc,
        );
        return;
      }
    }
  }

  /** Has the run hit either dead-loop ceiling (iteration count or token budget)? */
  private exhausted(iteration: number, used: TokenUsage): boolean {
    if (iteration >= this.maxToolIterations) return true;
    return this.turnTokenBudget !== undefined && used.totalTokens >= this.turnTokenBudget;
  }

  /**
   * Record + emit a `tool_step` row for a completed read-only call, so the
   * conversation shows the look-up on reload, not just live. Best-effort: if the
   * persist fails we emit nothing (and log it), keeping the live view and a
   * reload identical rather than showing a step that wouldn't survive.
   */
  private async *recordToolStep(
    companionId: string,
    name: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<ChatStreamEvent> {
    const tool = this.registry.get(name);
    const summary = tool ? toolStepSummary(tool, args) : `Used ${name}.`;
    try {
      const step = await this.memory.appendMessage(companionId, 'assistant', summary, {
        kind: 'tool_step',
        metadata: { toolName: name },
      });
      yield { type: 'tool_step', step };
    } catch (error) {
      this.logger.error('failed to record tool step', {
        operation: 'harness.recordToolStep',
        companionId,
        tool: name,
        error,
      });
    }
  }

  /** Persist the assistant turn, debit the run's tokens once, and emit `done`. */
  private async *finish(
    companionId: string,
    ownerId: string | undefined,
    text: string,
    citations: readonly Citation[],
    retrievalUsage: TokenUsage,
    acc: ReturnType<typeof createUsageAccumulator>,
  ): AsyncGenerator<ChatStreamEvent> {
    const message = await this.memory.appendMessage(
      companionId,
      'assistant',
      text,
      citations.length > 0 ? { metadata: { citations } } : undefined,
    );
    await this.debit(ownerId, addUsage(retrievalUsage, acc.total()));
    yield { type: 'done', message };
  }

  /**
   * Exit-for-approval: persist the companion's pre-amble (if any) and one
   * `proposal` transcript row per held action (so the propose→approve exchange
   * survives reload), surface every proposal for the queue, debit once, and emit
   * `done` with the last persisted row.
   */
  private async *finishBlocked(
    companionId: string,
    ownerId: string | undefined,
    turnText: string,
    heldProposals: readonly ProposalDto[],
    blockReason: string,
    citations: readonly Citation[],
    retrievalUsage: TokenUsage,
    acc: ReturnType<typeof createUsageAccumulator>,
  ): AsyncGenerator<ChatStreamEvent> {
    // The companion's spoken pre-amble (what it said before the held action),
    // if any — this is what the streamed token bubble finalizes to.
    let preamble: MessageDto | undefined;
    if (turnText.trim().length > 0) {
      preamble = await this.memory.appendMessage(
        companionId,
        'assistant',
        turnText,
        citations.length > 0 ? { metadata: { citations } } : undefined,
      );
    }
    let lastProposalRow: MessageDto | undefined;
    for (const proposal of heldProposals) {
      try {
        lastProposalRow = await this.memory.appendMessage(
          companionId,
          'assistant',
          proposal.summary,
          { kind: 'proposal', metadata: { proposalId: proposal.id, toolName: proposal.toolName } },
        );
      } catch (error) {
        this.logger.error('failed to persist proposal row', {
          operation: 'harness.finishBlocked',
          companionId,
          proposalId: proposal.id,
          error,
        });
      }
      yield { type: 'proposal', proposal };
    }
    await this.debit(ownerId, addUsage(retrievalUsage, acc.total()));
    // The stream MUST terminate with a persisted `done`. It carries the
    // companion's words when it spoke, else the last held proposal row. If
    // neither persisted — turnText was empty and every proposal-row write failed,
    // or a custom gate blocked with only a bare reason — record one terminal row
    // (the reason, or a proposal summary) so `done` still lands and the surface's
    // optimistic bubble is reconciled. If even that write fails, surface `error`
    // so a held turn never ends silently (§4.7).
    let doneMessage = preamble ?? lastProposalRow;
    if (!doneMessage) {
      const fallbackText = blockReason || heldProposals[0]?.summary || HELD_TURN_FALLBACK;
      try {
        doneMessage = await this.memory.appendMessage(companionId, 'assistant', fallbackText);
      } catch (error) {
        this.logger.error('failed to persist the terminal row for a held turn', {
          operation: 'harness.finishBlocked',
          companionId,
          error,
        });
        yield { type: 'error', message: TURN_ERROR_MESSAGE };
        return;
      }
    }
    yield { type: 'done', message: doneMessage };
  }

  /** Log a turn failure and build the terminal error event (failures are data, §4.7). */
  private failed(companionId: string, error: unknown): ChatStreamEvent {
    this.logger.error('turn failed', {
      operation: 'harness.runTurn',
      companionId,
      error,
    });
    return { type: 'error', message: TURN_ERROR_MESSAGE };
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
      // Only conversational turns enter the model's context; tool-step and
      // proposal rows are UI chrome (architecture.md §4.7).
      blocks: recent
        .filter((message) => (message.kind ?? 'message') === 'message')
        .map((message) => ({ role: message.role, content: message.content })),
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
