/**
 * Provider-agnostic LLM gateway (architecture.md §3, §5). The harness depends only
 * on this interface; swapping providers never touches the loop. Default impl:
 * OpenRouter (./openrouter.ts); tests use the FakeLlmGateway (./fake.ts).
 */

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmStreamParams {
  readonly messages: readonly LlmMessage[];
  readonly model: string;
  readonly signal?: AbortSignal;
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
  /** Stream the assistant response as incremental text deltas. */
  stream(params: LlmStreamParams): AsyncIterable<string>;
}
