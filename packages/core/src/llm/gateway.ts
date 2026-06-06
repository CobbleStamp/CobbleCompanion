/**
 * Provider-agnostic LLM gateway (architecture.md §3, §5). The harness depends only
 * on this interface; swapping providers never touches the loop. Default impl:
 * OpenRouter (./openrouter.ts); tests use the FakeLlmGateway (./fake.ts).
 */

import type { PromptRef } from '../prompts/types.js';
import type { TokenUsage } from '../usage.js';

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Set on a `tool`-role message: the id of the tool call this result answers. */
  readonly toolCallId?: string;
  /** Set on an `assistant` message that requested tools — replayed so the
   * provider can correlate the following `tool` messages to their calls. */
  readonly toolCalls?: readonly ToolCall[];
}

/**
 * A tool the model may call, in the wire shape the gateway advertises to the
 * provider. `parameters` is a JSON Schema object (hand-written per tool, M2).
 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * A tool invocation the model emitted, parsed from the provider stream. `id`
 * correlates the eventual `tool`-role result back to this call; `args` is the
 * parsed `function.arguments` JSON. This is the canonical tool-call value the
 * harness hooks (`BeforeToolCall`/`AfterToolCall`) also operate on.
 */
export interface ToolCall {
  readonly id?: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface LlmStreamParams {
  readonly messages: readonly LlmMessage[];
  readonly model: string;
  /** Tools to advertise this turn; omitted/empty = a text-only call (P0 path). */
  readonly tools?: readonly ToolDef[];
  readonly signal?: AbortSignal;
  /**
   * Which prompt version produced these messages (prompts/registry). Carried as
   * metadata for metering and tracing only — never sent to the provider. Optional
   * so ad-hoc/test calls and the FakeLlmGateway need no change.
   */
  readonly promptRef?: PromptRef;
  /**
   * Additional prompts that co-occur on this *same* provider call beyond the
   * primary {@link promptRef} — e.g. the affect-attunement system line stamped
   * alongside the persona. Recorded in the trace so the call's prompt stamp
   * fully describes what was sent; like {@link promptRef}, never sent to the
   * provider. Omitted/empty when the call is a single prompt.
   */
  readonly coPromptRefs?: readonly PromptRef[];
}

/**
 * What an LLM stream produces beyond its text deltas: the call's token usage and
 * any tool calls the model emitted. Returned as the generator's value so the
 * text relay (`for await` over the deltas) is unchanged for text-only callers.
 */
export interface StreamResult {
  readonly usage: TokenUsage;
  readonly toolCalls: readonly ToolCall[];
}

/** Typed gateway failure — provider errors surface as data, not raw throws (§4.7). */
export class LlmGatewayError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'LlmGatewayError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface LlmGateway {
  /**
   * Stream the assistant response as incremental text deltas; the generator's
   * **return value** is the {@link StreamResult} (usage + any tool calls), so
   * text-only consumers using `for await` are unaffected, while the harness and
   * metered callers read the return for tool calls / token accounting.
   */
  stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void>;
}
