import {
  type ChatStreamEvent,
  type Citation,
  type CompanionDto,
  type MessageDto,
  type ProposalDto,
  type UserFactDto,
} from '@cobble/shared';
import { randomUUID } from 'node:crypto';
import type { LlmGateway, LlmMessage, StreamResult } from '../llm/gateway.js';
import { toolStepSummary } from '../tools/tool.js';
import { consoleLogger, type Logger } from '../logging.js';
import { isConversational, type MemoryStore } from '../memory/store.js';
import type { AffectReading } from '../motivation/affect.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { BackgroundTaskGroup } from './background-tasks.js';
import {
  PostTurnPerception,
  type HarnessAffect,
  type HarnessUserModel,
} from './post-turn-perception.js';
import { dispatchTool } from '../tools/dispatch.js';
import { ToolRegistry } from '../tools/registry.js';

export type { HarnessAffect, HarnessUserModel } from './post-turn-perception.js';
import {
  guardedTraceSink,
  noopTraceSink,
  type TraceHandle,
  type TraceSink,
} from '../tracing/trace-sink.js';
import {
  addUsage,
  createUsageAccumulator,
  meteredLlmGateway,
  ZERO_USAGE,
  type TokenUsage,
} from '../usage.js';
import { assembleContext, coPromptRefs, PERSONA_REF } from './context.js';
import type { PromptRef } from '../prompts/index.js';
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
  /**
   * Resolve the effective registry for a turn from the companion id (Phase 9):
   * native tools + that companion's connected-MCP tools, composed behind the same
   * registry interface (companion-tools.md §4 — no loop change, invariant #3).
   * Omitted = the static {@link registry} is used for every turn. A resolver that
   * throws degrades to the static registry (acquisition never breaks the turn).
   */
  readonly resolveRegistry?: (companionId: string) => Promise<ToolRegistry>;
  /** Gate around every tool call — blocks effectful actions for approval (P3). */
  readonly beforeToolCall?: BeforeToolCall;
  /** Runs after each tool call — used to log every call (P3). */
  readonly afterToolCall?: AfterToolCall;
  /** Max assistant turns before exit-to-user-with-partial (dead-loop guard, §4.7). */
  readonly maxToolIterations?: number;
  /** Optional cumulative token ceiling per run — the second dead-loop guard (§4.7). */
  readonly turnTokenBudget?: number;
  /** Spends the turn's tokens from the companion's stamina wallet; omitted = no metering. */
  readonly quota?: VitalityStore;
  /** Affect perception + learning (Phase 4.2); omitted = no mood sensing. */
  readonly affect?: HarnessAffect;
  /** User-Model reads + capture (Phase 11); omitted = no user-model. */
  readonly userModel?: HarnessUserModel;
  /** Online tracing sink (Phase C); omitted = noop (tracing off). */
  readonly traceSink?: TraceSink;
  readonly logger?: Logger;
}

/**
 * The mid-turn embodiment fence (deliver-scalability.md §5.2). A turn is a
 * multi-step agent loop, not a single request, so the per-request `holds()` check
 * cannot stop a turn that is already running when a newer connection force-claims
 * the companion (the user moved rooms). When supplied, the loop re-reads this at the
 * top of every iteration and again before persisting the reply, and stands down
 * cleanly the moment it returns false — no assistant write, no post-turn nudge.
 * Omitted = no fence (single-connection tests / the pre-Phase-D path), the turn always
 * runs to completion.
 */
export type HoldsLease = () => Promise<boolean>;

export interface RunTurnParams {
  readonly companion: CompanionDto;
  readonly userContent: string;
  /** The companion's owner — the account the turn's tokens are debited to, and whose
   *  User-Model facts shape the persona + receive any captured identity facts. */
  readonly ownerId?: string;
  readonly signal?: AbortSignal;
  /** Mid-turn embodiment fence (see {@link HoldsLease}); omitted = no fence. */
  readonly holdsLease?: HoldsLease;
  /**
   * What kind of entry seeds this turn (see {@link TurnCtx.origin}): `mission` marks a
   * `mission.advance` wake turn, the only origin the approval gate's mission-mode bypass
   * honors. Omitted = `chat` (always gated).
   */
  readonly origin?: 'chat' | 'mission';
}

/** Resume after an approved action (continueAfterApproval). */
export interface ContinueParams {
  readonly companion: CompanionDto;
  /** The companion's owner — the account the turn is debited to + its User-Model owner. */
  readonly ownerId?: string;
  /** The completed action's result line, injected so the model knows it's done. */
  readonly outcome: string;
  readonly signal?: AbortSignal;
  /** Mid-turn embodiment fence (see {@link HoldsLease}); omitted = no fence. */
  readonly holdsLease?: HoldsLease;
}

/** The assembled prompt + retrieval results shared by both loop entry points. */
interface PreparedTurn {
  readonly messages: LlmMessage[];
  readonly citations: readonly Citation[];
  readonly retrievalUsage: TokenUsage;
  /** Prompts that co-occur with the persona on the turn's LLM call (e.g. the
   *  attunement line), stamped alongside {@link PERSONA_REF} so the trace
   *  describes the whole call. Empty when only the persona is sent. */
  readonly coPromptRefs: readonly PromptRef[];
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
  private readonly resolveRegistry: ((companionId: string) => Promise<ToolRegistry>) | undefined;
  private readonly beforeToolCall: BeforeToolCall;
  private readonly afterToolCall: AfterToolCall;
  private readonly maxToolIterations: number;
  private readonly turnTokenBudget: number | undefined;
  private readonly quota: VitalityStore | undefined;
  private readonly affect: HarnessAffect | undefined;
  private readonly userModel: HarnessUserModel | undefined;
  private readonly traceSink: TraceSink;
  private readonly logger: Logger;
  /** Post-turn perception + learning (affect sense + user-fact capture), launched
   *  fire-and-forget after the reply streams; owns its own per-key serialization. */
  private readonly perception: PostTurnPerception;
  /** The fire-and-forget background tasks (the perception reads), awaitable on
   *  shutdown / in tests via {@link whenIdle}. */
  private readonly background = new BackgroundTaskGroup();

  constructor(options: HarnessOptions) {
    this.gateway = options.gateway;
    this.memory = options.memory;
    this.model = options.model;
    this.recentLimit = options.recentLimit ?? 20;
    this.logger = options.logger ?? consoleLogger;
    this.retrieveContext = options.retrieveContext ?? this.defaultRetrieveContext;
    this.registry = options.registry ?? new ToolRegistry();
    this.resolveRegistry = options.resolveRegistry;
    this.beforeToolCall = options.beforeToolCall ?? passthroughBeforeToolCall;
    this.afterToolCall = options.afterToolCall ?? passthroughAfterToolCall;
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.turnTokenBudget = options.turnTokenBudget;
    this.quota = options.quota;
    this.affect = options.affect;
    this.userModel = options.userModel;
    this.perception = new PostTurnPerception({
      gateway: this.gateway,
      logger: this.logger,
      quota: this.quota,
      affect: this.affect,
      userModel: this.userModel,
    });
    // Guard the sink so a misbehaving adapter can never break a turn (logging.md).
    this.traceSink = guardedTraceSink(options.traceSink ?? noopTraceSink, (error) =>
      this.logger.error('trace sink failed (tracing dropped for this call)', {
        operation: 'harness.trace',
        error,
      }),
    );
  }

  /**
   * Run one ENTRY through the loop, streaming the assistant turn as events. The
   * user message is persisted on entry; the assistant message on exit (the
   * transcript is the source of truth, §4.7).
   */
  async *runTurn(params: RunTurnParams): AsyncGenerator<ChatStreamEvent, boolean> {
    const { companion, userContent, ownerId, signal, holdsLease, origin } = params;
    const trace = this.traceSink.startTrace({
      traceId: randomUUID(),
      name: 'turn',
      companionId: companion.id,
      ...(ownerId ? { ownerId } : {}),
    });
    let traceError: string | undefined;
    try {
      const userMessage = await this.memory.appendMessage(companion.id, 'user', userContent);
      const prep = await this.prepare(companion, userContent, trace, ownerId);
      // Snapshot the transcript for the post-turn perception reads (affect + user-fact
      // capture) NOW, while the user's message is still the final row. Once the reply
      // persists (end of runLoop) it becomes the final row, and `affectContext` — which
      // drops the final turn as "the message being read" — would drop the reply instead,
      // leaving the user message duplicated against `userText`. Capturing here keeps that
      // invariant. Skipped entirely when neither perception is wired (no extra query).
      const perceptionSnapshot = this.perception.needsSnapshot(ownerId)
        ? await this.memory.getRecentMessages(companion.id, this.recentLimit)
        : [];
      const superseded = yield* this.runLoop(
        companion,
        ownerId,
        prep,
        signal,
        trace,
        holdsLease,
        userMessage.id,
        origin,
      );
      // Mid-turn handoff (deliver-scalability.md §5.2): a newer connection
      // force-claimed this companion while the loop ran, so the loop stood down
      // without writing the reply. SKIP all post-turn perception — the affect read
      // hands a non-idempotent `driveWeights` nudge to the will, and the live turn
      // the user now sees (on the new connection) owns that learning. The trace
      // still ends in `finally`. Tell the caller so it stops streaming + closes.
      if (superseded) {
        return true;
      }
      // Perception + learning (Phase 4.2 affect, Phase 11–12 capture) — launched AFTER
      // the reply has fully streamed (all tokens + `done` already yielded) and
      // deliberately NOT awaited: the generator returns immediately so the SSE socket
      // closes on `done` and the route's post-turn nudges fire without waiting a full
      // round-trip. Awaiting bought no ordering — the client is told `done` before this
      // runs, so the next turn already races these reads either way. The perception owns
      // the per-key serialization (companion for affect, user for capture) and is
      // self-catching, so the tracked promises can't surface as unhandled rejections.
      for (const task of this.perception.afterTurn({
        companionId: companion.id,
        ownerId,
        userContent,
        snapshot: perceptionSnapshot,
      })) {
        this.background.track(task);
      }
      return false;
    } catch (error) {
      traceError = error instanceof Error ? error.message : String(error);
      yield this.failed(companion.id, error);
      // A failed turn is not a handoff — the caller should surface the error and
      // keep the connection, not close it as superseded.
      return false;
    } finally {
      // End the turn trace on EVERY exit — normal, error, or consumer abort
      // (generator .return()), so a trace is never left open. Best-effort.
      trace.end(traceError !== undefined ? { error: traceError } : undefined);
    }
  }

  /**
   * Resolves once every in-flight post-turn read has settled. The reads are launched
   * fire-and-forget from {@link runTurn} so the SSE socket can close on `done`; this
   * lets a graceful shutdown — or a test asserting the read's effects — wait for that
   * background work to finish. Never rejects: each task self-catches.
   */
  async whenIdle(): Promise<void> {
    await this.background.whenIdle();
  }

  /**
   * Resume the conversation after the user approves a held action. No new user
   * message is persisted — the approval is the ENTRY. The recency window carries
   * the original request and the companion's pre-amble; an ephemeral note tells
   * the model the action just completed (the persisted `tool_step` row is the UI
   * record, but it's filtered out of context), so the model narrates the outcome
   * and continues whatever was asked ("…then summarize what you saved").
   */
  async *continueAfterApproval(params: ContinueParams): AsyncGenerator<ChatStreamEvent, boolean> {
    const { companion, ownerId, outcome, signal, holdsLease } = params;
    const trace = this.traceSink.startTrace({
      traceId: randomUUID(),
      name: 'turn',
      companionId: companion.id,
      ...(ownerId ? { ownerId } : {}),
    });
    let traceError: string | undefined;
    try {
      const prep = await this.prepare(companion, '', trace, ownerId);
      prep.messages.push({
        role: 'user',
        content:
          `[Your proposed action was approved and has completed: ${outcome} ` +
          `Continue with what the user asked — do not propose it again.]`,
      });
      return yield* this.runLoop(companion, ownerId, prep, signal, trace, holdsLease);
    } catch (error) {
      traceError = error instanceof Error ? error.message : String(error);
      yield this.failed(companion.id, error);
      return false;
    } finally {
      trace.end(traceError !== undefined ? { error: traceError } : undefined);
    }
  }

  /** The user's current Tier-1 core profile, or [] (best-effort — never throws). */
  private async userProfile(ownerId: string | undefined): Promise<readonly UserFactDto[]> {
    if (!this.userModel || !ownerId) {
      return [];
    }
    try {
      return await this.userModel.store.listCurrent(ownerId);
    } catch (error) {
      this.logger.error('failed to load user profile for persona', {
        operation: 'harness.userProfile',
        ownerId,
        error,
      });
      return [];
    }
  }

  /** The companion's prior rolling mood read, or null (best-effort — never throws). */
  private async priorAffect(companionId: string): Promise<AffectReading | null> {
    if (!this.affect) {
      return null;
    }
    try {
      return await this.affect.store.get(companionId);
    } catch (error) {
      this.logger.error('failed to load prior affect for attunement', {
        operation: 'harness.priorAffect',
        companionId,
        error,
      });
      return null;
    }
  }

  /** Retrieve context, assemble the prompt, and collect the turn's citations. */
  private async prepare(
    companion: CompanionDto,
    userContent: string,
    trace: TraceHandle,
    ownerId: string | undefined,
  ): Promise<PreparedTurn> {
    const span = trace.startSpan({ kind: 'assemble_context', name: 'assemble_context' });
    try {
      const { blocks: history, usage: retrievalUsage } = await this.retrieveContext({
        companionId: companion.id,
        userContent,
        ...(ownerId ? { ownerId } : {}),
      });
      // Fast-loop attunement (Phase 4.2): the prior rolling read of the user's mood
      // is fed forward so this reply adjusts tone/detail to where they are.
      // Best-effort — a store hiccup must never block the reply (just lose attunement).
      const affect = await this.priorAffect(companion.id);
      // Tier-1 core profile (Phase 11): the user's current identity facts, rendered
      // into the persona so the reply addresses a known person. Best-effort — a store
      // hiccup loses the profile, never the reply.
      const profile = await this.userProfile(ownerId);
      const messages = assembleContext(companion, history, affect, profile);
      const citations = dedupeCitations(history.flatMap((block) => block.provenance ?? []));
      span.end({
        attributes: { blocks: history.length, citations: citations.length },
      });
      return { messages, citations, retrievalUsage, coPromptRefs: coPromptRefs(affect) };
    } catch (error) {
      span.end({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
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
    trace: TraceHandle,
    holdsLease: HoldsLease | undefined,
    currentUserMessageId?: string,
    origin?: 'chat' | 'mission',
  ): AsyncGenerator<ChatStreamEvent, boolean> {
    const { messages, citations, retrievalUsage, coPromptRefs } = prep;
    // Citations are retrieval-time data: surface the grounding sources as soon
    // as they are known, before (and independent of) the token stream.
    if (citations.length > 0) {
      yield { type: 'citations', citations };
    }

    // Meter every LLM call in the run: the wrapper deposits each call's usage
    // into `acc`, so a multi-turn tool run is debited once, at exit.
    const acc = createUsageAccumulator();
    const llm = meteredLlmGateway(this.gateway, acc.sink, trace);
    const ctx: TurnCtx = {
      companionId: companion.id,
      ownerId: ownerId ?? '',
      ...(origin ? { origin } : {}),
      ...(currentUserMessageId ? { currentUserMessageId } : {}),
    };

    // A finish path debits once and sets this; any other exit (a client
    // disconnect that `.return()`s the generator, or a provider/infra fault that
    // throws) is abnormal and the `finally` settles the bill instead.
    let settledNormally = false;
    // The stream of the turn in flight, hoisted so the `finally` can forward
    // termination into it (cancels its connection and lets the metering wrapper
    // deposit a client-aborted turn's estimate before we read `acc`).
    let activeStream: AsyncGenerator<string, StreamResult, void> | undefined;
    let lastText = '';
    try {
      for (let iteration = 0; ; iteration++) {
        // The long-turn embodiment fence (deliver-scalability.md §5.2): a turn is a
        // multi-step loop, so the per-request `holds()` check can't stop one already
        // running when a newer connection force-claims the companion. Re-read the
        // lease at the TOP of every iteration; if it moved, stand down WITHOUT
        // writing the reply — the turn the user now sees runs on the new connection.
        // `settledNormally` stays false so the `finally` debits the tokens already
        // metered (retrieval + completed steps were really spent) and tears down any
        // in-flight stream. The bounded overlap is one in-flight step.
        if (await this.stoodDown(holdsLease, companion.id, iteration, 'turn stood down mid-loop')) {
          return true;
        }

        if (this.exhausted(iteration, acc.total())) {
          this.logger.error('turn hit its budget ceiling; exiting with partial', {
            operation: 'harness.runLoop',
            companionId: companion.id,
            iteration,
            tokens: acc.total().totalTokens,
          });
          settledNormally = true;
          yield* this.finish(
            companion.id,
            lastText || PARTIAL_FALLBACK,
            citations,
            retrievalUsage,
            acc,
          );
          return false;
        }

        // The effective registry is resolved PER STEP (companion-tools.md §4), so a
        // tool the model loads with load_tool mid-turn is advertised + dispatchable
        // on the next iteration. The loop shape is unchanged (invariant #3); only
        // *when* the tool set is computed moves from per-turn to per-step. The
        // resolver reads cached snapshots — no network — and degrades to the static
        // registry on error, so acquisition never breaks the turn.
        const registry = await this.resolveTurnRegistry(companion.id);
        const toolDefs = registry.list();

        let turnText = '';
        const stream = llm.stream({
          messages,
          model: this.model,
          promptRef: PERSONA_REF,
          ...(coPromptRefs.length > 0 ? { coPromptRefs } : {}),
          ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
          ...(signal ? { signal } : {}),
        });
        activeStream = stream;
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
          // Owner-fenced write (deliver-scalability.md §5.2): the last LLM call can
          // run for seconds, during which the lease may have moved. Re-check before
          // persisting the reply so a turn that lost the lease mid-call does not
          // write its assistant message. `finally` debits the metered tokens.
          if (
            await this.stoodDown(
              holdsLease,
              companion.id,
              iteration,
              'turn stood down before reply',
            )
          ) {
            return true;
          }
          settledNormally = true;
          yield* this.finish(companion.id, turnText, citations, retrievalUsage, acc);
          return false;
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
          const toolSpan = trace.startSpan({
            kind: 'tool_call',
            name: gated.name,
            attributes: { tool: gated.name },
            content: { args: gated.args },
          });
          const result = await dispatchTool(
            registry,
            gated.name,
            gated.args,
            ctx,
            this.logger,
            call.id,
          );
          const logged = await this.afterToolCall(result, gated, ctx);
          toolSpan.end({
            attributes: { isError: result.isError === true },
            content: { result: logged.content },
          });
          messages.push({
            role: 'tool',
            content: logged.content,
            ...(call.id !== undefined ? { toolCallId: call.id } : {}),
          });
          // Record a friendly one-line transcript row for the look-up so the
          // conversation shows what the companion did (UI-only; filtered out of
          // the model's context). Best-effort — see recordToolStep. A failed
          // call (unknown tool / thrown — dispatch flags it isError) records
          // nothing: a "Searched memory for…" row for a lookup that errored would
          // misreport failure as success. The model still sees the error via the
          // tool message pushed above.
          // A `silent` tool (the companion's `react` emit) records no chrome row —
          // its own artifact is the user-visible record (companion-reactions.md §5).
          if (result.isError !== true && registry.get(gated.name)?.silent !== true) {
            // Owner-fenced write (embodiment-handoff-fencing.md §3, deliver-scalability.md
            // §5.2): tool dispatch above can run for seconds, during which the lease may
            // have moved. Re-check before writing the tool-step transcript row so a turn
            // that lost the lease mid-dispatch does not record chrome for the superseded
            // connection. Stand down like the reply/held paths — the new connection's turn
            // re-derives the step; otherwise both connections write rows for one companion.
            if (
              await this.stoodDown(
                holdsLease,
                companion.id,
                iteration,
                'turn stood down before tool-step write',
              )
            ) {
              return true;
            }
            yield* this.recordToolStep(registry, companion.id, gated.name, gated.args);
          }
        }

        // Any held action means the run pauses for approval: persist the pre-amble
        // and each proposal row (so they survive reload), surface the proposals,
        // and EXIT. Approving re-enters via continueAfterApproval (confirm route).
        if (blocked) {
          // Owner-fenced write: don't persist the pre-amble + proposal rows (nor
          // surface the proposals) under a stale lease. The new connection's turn
          // re-derives the held action; otherwise both turns would write it.
          if (await this.stoodDown(holdsLease, companion.id, iteration, 'held turn stood down')) {
            return true;
          }
          settledNormally = true;
          yield* this.finishBlocked(
            companion.id,
            turnText,
            heldProposals,
            blockReason,
            citations,
            retrievalUsage,
            acc,
          );
          return false;
        }
      }
    } finally {
      // Abnormal exit (no finish path ran): the run was abandoned mid-stream.
      // Forward termination into the in-flight stream so it cancels its
      // connection and the metering wrapper deposits a client-aborted turn's
      // estimated tokens into `acc` BEFORE we read it here. Then debit what was
      // metered: a client disconnect bills the tokens already streamed to the
      // user; a provider/infra fault left the failed turn out of `acc`, so only
      // the already-completed turns are billed — the broken part is free
      // (billing-crash-compensation).
      if (!settledNormally) {
        await activeStream
          ?.return({ usage: ZERO_USAGE, toolCalls: [] } satisfies StreamResult)
          .catch(() => undefined);
        await this.debit(companion.id, addUsage(retrievalUsage, acc.total()));
      }
    }
  }

  /**
   * The effective tool registry for a turn (Phase 9). With no resolver, the static
   * registry serves every turn (the pre-Phase-9 path). A resolver lets the API
   * compose native + per-companion acquired tools; if it throws, we degrade to the
   * static registry so tool acquisition can never break a turn (companion-tools.md §4).
   */
  private async resolveTurnRegistry(companionId: string): Promise<ToolRegistry> {
    if (!this.resolveRegistry) {
      return this.registry;
    }
    try {
      return await this.resolveRegistry(companionId);
    } catch (error) {
      this.logger.error('failed to resolve per-companion tool registry; using base registry', {
        operation: 'harness.resolveTurnRegistry',
        companionId,
        error,
      });
      return this.registry;
    }
  }

  /**
   * Has this turn lost the embodiment lease (deliver-scalability.md §5.2)? A single
   * indexed PK read on `active_embodiment` — cheap enough to call once per loop
   * iteration and before the reply append. No fence wired (tests / pre-Phase-D) → the
   * turn always holds. A read failure is treated as STILL HELD (`false`): a transient
   * DB hiccup must not abandon a turn the connection legitimately owns — the bounded
   * overlap is the deliberate tradeoff, and the next iteration's check retries.
   */
  private async leaseLost(holdsLease: HoldsLease | undefined): Promise<boolean> {
    if (!holdsLease) {
      return false;
    }
    try {
      return !(await holdsLease());
    } catch (error) {
      this.logger.error('embodiment lease check failed; treating turn as still held', {
        operation: 'harness.leaseLost',
        error,
      });
      return false;
    }
  }

  /**
   * Owner-fence checkpoint (deliver-scalability.md §5.2): true if this turn has
   * lost the embodiment lease and must stand down WITHOUT its pending write, logged
   * with `where` so the four runLoop checkpoints (mid-loop, before-reply,
   * before-tool-step-write, held) stay distinguishable. The single place the
   * "lease moved → log → stand down" decision lives.
   */
  private async stoodDown(
    holdsLease: HoldsLease | undefined,
    companionId: string,
    iteration: number,
    where: string,
  ): Promise<boolean> {
    if (!(await this.leaseLost(holdsLease))) {
      return false;
    }
    this.logger.info(`${where} — embodiment was superseded`, {
      operation: 'harness.runLoop',
      companionId,
      iteration,
    });
    return true;
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
    registry: ToolRegistry,
    companionId: string,
    name: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<ChatStreamEvent> {
    const tool = registry.get(name);
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
    await this.debit(companionId, addUsage(retrievalUsage, acc.total()));
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
    await this.debit(companionId, addUsage(retrievalUsage, acc.total()));
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
   * Debit the turn's tokens against the companion's stamina wallet (chat is
   * user-initiated work — the stamina half of the companion's vitality,
   * architecture.md §4.8). Best-effort: a metering failure is logged but never
   * breaks the conversation (logging.md), and turns with no quota (e.g. tests)
   * simply skip metering.
   */
  private async debit(companionId: string, usage: TokenUsage): Promise<void> {
    if (!this.quota || usage.totalTokens <= 0) {
      return;
    }
    try {
      await this.quota.spend(companionId, usage.totalTokens);
    } catch (error) {
      this.logger.error('failed to record chat token usage', {
        operation: 'harness.debit',
        companionId,
        error,
      });
    }
  }

  // The no-memory FALLBACK used only when no `retrieveContext` is injected (bare
  // harness, most unit tests): a plain recency window, no recall. Production wires
  // the real stack — episodic + procedural + semantic recall arms composed via
  // `composeRetrieveContext` (see packages/api/src/index.ts) — so "the harness only
  // does recency" is true of THIS default, never of the running app.
  private defaultRetrieveContext: RetrieveContext = async ({ companionId }) => {
    const recent = await this.memory.getRecentMessages(companionId, this.recentLimit);
    return {
      // Only conversational turns enter the model's context; tool-step and
      // proposal rows are UI chrome (architecture.md §4.7).
      blocks: recent
        .filter(isConversational)
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
