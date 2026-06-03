import { estimateUsage, type TokenUsage } from '../usage.js';
import type { LlmGateway, LlmStreamParams } from './gateway.js';

/**
 * Deterministic in-memory gateway for tests and offline dev (LLM_PROVIDER=fake).
 * Streams the configured chunks; records the params it was last called with;
 * returns a deterministic usage estimate so metering tests assert real numbers.
 * Per testing.md, we fake the gateway interface rather than mock the real client.
 */
export class FakeLlmGateway implements LlmGateway {
  lastParams: LlmStreamParams | null = null;

  constructor(private readonly chunks: readonly string[] = ['Hello', ' there!']) {}

  async *stream(params: LlmStreamParams): AsyncGenerator<string, TokenUsage, void> {
    this.lastParams = params;
    for (const chunk of this.chunks) {
      yield chunk;
    }
    return estimateUsage(
      params.messages.map((message) => message.content).join('\n'),
      this.chunks.join(''),
    );
  }
}
