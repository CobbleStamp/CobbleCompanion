import type { LlmGateway, LlmStreamParams } from './gateway.js';

/**
 * Deterministic in-memory gateway for tests and offline dev (LLM_PROVIDER=fake).
 * Streams the configured chunks; records the params it was last called with.
 * Per testing.md, we fake the gateway interface rather than mock the real client.
 */
export class FakeLlmGateway implements LlmGateway {
  lastParams: LlmStreamParams | null = null;

  constructor(private readonly chunks: readonly string[] = ['Hello', ' there!']) {}

  async *stream(params: LlmStreamParams): AsyncIterable<string> {
    this.lastParams = params;
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}
