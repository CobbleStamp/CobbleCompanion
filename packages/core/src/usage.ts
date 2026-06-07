/**
 * Token usage — the unit the vitality wallets meter (architecture.md token
 * budget). Both gateways surface it: the LLM gateway returns it as its stream's
 * return value, the embedding gateway alongside its vectors. Helpers here keep
 * the accounting honest when a provider omits usage (estimate, never silently 0)
 * and let callers tally usage across many calls.
 */

import type { LlmGateway, LlmMessage, StreamResult } from './llm/gateway.js';
import type { TraceHandle } from './tracing/trace-sink.js';

/** Prompt/completion/total token counts for one LLM or embedding call. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Sum two usage records component-wise (immutably). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Rough token count when a provider omits usage (~4 chars/token, OpenAI's heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build an estimated usage record from prompt + completion text (fallback path). */
export function estimateUsage(promptText: string, completionText: string): TokenUsage {
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** A place to deposit usage as calls complete (the metering wrapper's target). */
export interface UsageSink {
  add(usage: TokenUsage): void;
}

/** A running usage tally plus the sink that feeds it. */
export interface UsageAccumulator {
  readonly sink: UsageSink;
  total(): TokenUsage;
}

/** Create a fresh tally; pass `.sink` to {@link meteredLlmGateway}, read `.total()` after. */
export function createUsageAccumulator(): UsageAccumulator {
  let total = ZERO_USAGE;
  return {
    sink: { add: (usage) => (total = addUsage(total, usage)) },
    total: () => total,
  };
}

/** A {@link StreamResult} with no usage and no tool calls (the fallback). */
const ZERO_STREAM_RESULT: StreamResult = { usage: ZERO_USAGE, toolCalls: [] };

/** The prompt side of a call, for estimating usage when no usage frame arrived. */
function promptText(messages: readonly LlmMessage[]): string {
  return messages.map((message) => message.content).join('\n');
}

/**
 * Wrap an LLM gateway so every stream's final usage (carried on the generator's
 * {@link StreamResult} return value) is deposited into `sink` — even when the
 * consumer drains the stream with `for await` and discards the return. The
 * deposit happens in the generator body on the terminating `.next()` call, which
 * `for await` always makes, so callers like the segmenter/enricher need no change
 * to be metered. Any tool calls are passed through on the return untouched.
 *
 * Abnormal termination is metered too, and the cause decides how:
 *   - **Consumer abort** (the consumer stops pulling — a client disconnect) —
 *     the user has already received `streamedText`, so an estimate of the tokens
 *     consumed so far is deposited. Otherwise a client could stream a full answer
 *     and disconnect right before the provider's trailing usage frame to dodge
 *     the charge (unbounded free work).
 *   - **Provider/infra fault** (the inner stream throws) — left unmetered. We eat
 *     our own failures rather than bill the user for a turn that broke on our side
 *     (billing-crash-compensation): only the specific failed part is free.
 * Either way the inner stream's `.return()` is invoked so it cancels its
 * connection — manual iteration does not forward that automatically.
 */
export function meteredLlmGateway(
  inner: LlmGateway,
  sink: UsageSink,
  trace?: TraceHandle,
): LlmGateway {
  return {
    async *stream(params) {
      const iterator = inner.stream(params);
      // Open an llm_call span (no-op unless a real trace is wired). The prompt
      // version is metadata; the messages are redactable content. The span is
      // closed in `finally` with the call's usage + any error.
      const span = trace?.startSpan({
        kind: 'llm_call',
        name: params.model,
        attributes: {
          model: params.model,
          ...(params.promptRef
            ? {
                promptId: params.promptRef.id,
                promptSemver: params.promptRef.version.semver,
                promptHash: params.promptRef.version.contentHash,
              }
            : {}),
          // Co-occurring prompts (e.g. the affect-attunement line beside the
          // persona) so the stamp describes the whole call, not just the
          // primary prompt. One triple per co-prompt; omitted when there are none.
          ...(params.coPromptRefs && params.coPromptRefs.length > 0
            ? {
                coPrompts: params.coPromptRefs.map((ref) => ({
                  promptId: ref.id,
                  promptSemver: ref.version.semver,
                  promptHash: ref.version.contentHash,
                })),
              }
            : {}),
        },
        content: { messages: params.messages },
      });
      let settled = false; // saw the terminating return value (clean completion)
      let faulted = false; // the inner stream threw — a provider/infra fault
      let streamedText = '';
      let usage: TokenUsage = ZERO_USAGE;
      let faultError: unknown;
      try {
        for (;;) {
          let step: IteratorResult<string, StreamResult>;
          try {
            step = await iterator.next();
          } catch (error) {
            faulted = true;
            faultError = error;
            throw error;
          }
          if (step.done) {
            const result = step.value ?? ZERO_STREAM_RESULT;
            sink.add(result.usage);
            usage = result.usage;
            settled = true;
            return result;
          }
          streamedText += step.value;
          yield step.value;
        }
      } finally {
        if (!settled && !faulted) {
          usage = estimateUsage(promptText(params.messages), streamedText);
          sink.add(usage);
        }
        span?.end({
          attributes: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          },
          content: { output: streamedText },
          ...(faulted ? { error: errorMessage(faultError) } : {}),
        });
        await iterator.return?.(ZERO_STREAM_RESULT).catch(() => undefined);
      }
    },
  };
}

/** A safe string for a thrown value (no secrets — just the message/type). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
