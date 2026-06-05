import { estimateUsage } from '../usage.js';
import type { LlmGateway, LlmStreamParams, StreamResult, ToolCall } from './gateway.js';

/** A scripted stream turn: text chunks plus any tool calls the model "emits". */
export interface FakeTurn {
  readonly chunks?: readonly string[];
  readonly toolCalls?: readonly ToolCall[];
}

/**
 * Deterministic in-memory gateway for tests and offline dev (LLM_PROVIDER=fake).
 * Streams the configured chunks and returns scripted tool calls + a deterministic
 * usage estimate, so metering and tool-loop tests assert real numbers. When given
 * multiple turns it advances one per `stream()` call (driving multi-turn tool
 * loops). Per testing.md, we fake the gateway interface rather than mock the real
 * client.
 */
export class FakeLlmGateway implements LlmGateway {
  lastParams: LlmStreamParams | null = null;
  /** Every params object this gateway was called with, in order. */
  readonly calls: LlmStreamParams[] = [];
  private readonly turns: readonly FakeTurn[];
  private turnIndex = 0;

  constructor(turns: readonly string[] | readonly FakeTurn[] = ['Hello', ' there!']) {
    this.turns = normalizeTurns(turns);
  }

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    this.lastParams = params;
    this.calls.push(params);
    // Advance one scripted turn per call; the last turn repeats once exhausted so
    // a single-turn fake behaves as before.
    const turn = this.turns[Math.min(this.turnIndex, this.turns.length - 1)] ?? {};
    this.turnIndex += 1;
    const chunks = turn.chunks ?? [];
    for (const chunk of chunks) {
      yield chunk;
    }
    return {
      usage: estimateUsage(
        params.messages.map((message) => message.content).join('\n'),
        chunks.join(''),
      ),
      toolCalls: turn.toolCalls ?? [],
    };
  }
}

/** Accept either a flat chunk list (one text turn) or explicit scripted turns. */
function normalizeTurns(turns: readonly string[] | readonly FakeTurn[]): readonly FakeTurn[] {
  if (turns.length > 0 && typeof turns[0] === 'string') {
    return [{ chunks: turns as readonly string[] }];
  }
  return turns as readonly FakeTurn[];
}
