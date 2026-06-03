/**
 * Token usage — the unit the per-user daily cap meters (architecture.md token
 * budget). Both gateways surface it: the LLM gateway returns it as its stream's
 * return value, the embedding gateway alongside its vectors. Helpers here keep
 * the accounting honest when a provider omits usage (estimate, never silently 0)
 * and let callers tally usage across many calls.
 */

import type { LlmGateway } from './llm/gateway.js';

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

/**
 * Wrap an LLM gateway so every stream's final usage (the generator's return
 * value) is deposited into `sink` — even when the consumer drains the stream
 * with `for await` and discards the return. The deposit happens in the generator
 * body on the terminating `.next()` call, which `for await` always makes, so
 * callers like the segmenter/enricher need no change to be metered.
 */
export function meteredLlmGateway(inner: LlmGateway, sink: UsageSink): LlmGateway {
  return {
    async *stream(params) {
      const iterator = inner.stream(params);
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) {
          const usage = value ?? ZERO_USAGE;
          sink.add(usage);
          return usage;
        }
        yield value;
      }
    },
  };
}
