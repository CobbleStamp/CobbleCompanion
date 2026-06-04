import { estimateUsage, type TokenUsage } from '../usage.js';
import {
  type LlmGateway,
  LlmGatewayError,
  type LlmMessage,
  type LlmStreamParams,
  type StreamResult,
  type ToolCall,
  type ToolDef,
} from './gateway.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/**
 * OpenRouter-backed gateway. OpenRouter exposes an OpenAI-compatible streaming
 * chat-completions endpoint; we relay `choices[0].delta.content` deltas and
 * accumulate `choices[0].delta.tool_calls` fragments into whole tool calls.
 */
export class OpenRouterGateway implements LlmGateway {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? OPENROUTER_URL;
  }

  async *stream(params: LlmStreamParams): AsyncGenerator<string, StreamResult, void> {
    const response = await this.requestStream(params);
    const body = response.body;
    if (!body) {
      throw new LlmGatewayError('OpenRouter returned an empty response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: TokenUsage | null = null;
    // Tool calls stream as deltas keyed by `index`: the first fragment carries
    // id + function.name + a partial arguments string, later fragments append
    // more arguments text. We accumulate per index and parse arguments once at
    // the end (architecture.md §4.2).
    const toolBuffers = new Map<number, ToolCallBuffer>();
    // If the model omits usage, estimate from the prompt + streamed completion so
    // accounting is never silently zero (architecture.md token budget).
    const fallbackUsage = (): TokenUsage =>
      estimateUsage(params.messages.map((message) => message.content).join('\n'), text);
    const result = (): StreamResult => ({
      usage: usage ?? fallbackUsage(),
      toolCalls: buildToolCalls(toolBuffers),
    });
    const reader = body.getReader();
    // Tracks whether the reader drained to its natural end. A consumer that
    // breaks out early (or a thrown error) leaves this false, so the `finally`
    // cancels the body — `releaseLock()` alone leaks the underlying connection.
    let drained = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          drained = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const frame = parseSseLine(line);
          if (frame === DONE) {
            drained = true;
            return result();
          }
          if (!frame) continue;
          if (frame.content) {
            text += frame.content;
            yield frame.content;
          }
          if (frame.toolCalls) {
            accumulateToolCalls(toolBuffers, frame.toolCalls);
          }
          if (frame.usage) {
            usage = frame.usage;
          }
        }
      }
    } finally {
      if (!drained) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
    return result();
  }

  private async requestStream(params: LlmStreamParams): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          stream: true,
          messages: params.messages.map(toWireMessage),
          // Advertise tools (OpenAI function-tool shape) only when the turn has
          // any — a text-only turn sends no `tools` field (P0 path unchanged).
          ...(params.tools && params.tools.length > 0
            ? { tools: params.tools.map(toToolPayload) }
            : {}),
          // Ask OpenRouter to append a final usage frame to the stream.
          usage: { include: true },
        }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (cause) {
      throw new LlmGatewayError('OpenRouter request failed', cause);
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new LlmGatewayError(`OpenRouter responded ${response.status}: ${detail}`);
    }
    return response;
  }
}

const DONE = Symbol('done');

/** A tool call assembled across stream fragments (arguments arrive in pieces). */
interface ToolCallBuffer {
  id?: string;
  name?: string;
  argsText: string;
}

/** One `delta.tool_calls[]` entry as the provider streams it (all parts optional). */
interface RawToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsFragment?: string;
}

/** A parsed SSE data frame: content delta, usage report, tool-call deltas — any mix. */
interface SseFrame {
  readonly content?: string;
  readonly usage?: TokenUsage;
  readonly toolCalls?: readonly RawToolCallDelta[];
}

/**
 * Map an {@link LlmMessage} to the OpenAI/OpenRouter wire shape. A `tool`-role
 * message carries its `tool_call_id`; an assistant message that made tool calls
 * replays them as `tool_calls` so the provider can correlate the results.
 */
function toWireMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        ...(call.id !== undefined ? { id: call.id } : {}),
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Map a {@link ToolDef} to the OpenAI/OpenRouter `tools[]` request shape. */
function toToolPayload(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Fold this frame's tool-call deltas into the per-index accumulation buffers. */
function accumulateToolCalls(
  buffers: Map<number, ToolCallBuffer>,
  deltas: readonly RawToolCallDelta[],
): void {
  for (const delta of deltas) {
    const buffer = buffers.get(delta.index) ?? { argsText: '' };
    if (delta.id !== undefined) buffer.id = delta.id;
    if (delta.name !== undefined) buffer.name = delta.name;
    if (delta.argumentsFragment !== undefined) buffer.argsText += delta.argumentsFragment;
    buffers.set(delta.index, buffer);
  }
}

/**
 * Finalize the accumulated buffers into tool calls, parsing each arguments
 * string as JSON. A buffer with no name is dropped (nothing callable); malformed
 * arguments degrade to `{}` so a bad fragment is data, not a throw (§4.7) — the
 * harness surfaces an empty-arg call as an ordinary (failing) tool result.
 */
function buildToolCalls(buffers: Map<number, ToolCallBuffer>): readonly ToolCall[] {
  const calls: ToolCall[] = [];
  for (const index of [...buffers.keys()].sort((a, b) => a - b)) {
    const buffer = buffers.get(index)!;
    if (!buffer.name) continue;
    calls.push({
      ...(buffer.id !== undefined ? { id: buffer.id } : {}),
      name: buffer.name,
      args: parseArgs(buffer.argsText),
    });
  }
  return calls;
}

/** Parse a tool-call arguments string; empty or malformed JSON → `{}`. */
function parseArgs(argsText: string): Record<string, unknown> {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Parse one SSE line into a frame (content/usage/tool-calls), DONE, or null to skip. */
function parseSseLine(line: string): SseFrame | typeof DONE | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '[DONE]') return DONE;
  try {
    const parsed = JSON.parse(payload) as {
      choices?: ReadonlyArray<{
        delta?: {
          content?: string;
          tool_calls?: ReadonlyArray<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const delta = parsed.choices?.[0]?.delta;
    const frame: { content?: string; usage?: TokenUsage; toolCalls?: RawToolCallDelta[] } = {};
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      frame.content = delta.content;
    }
    const toolCalls = parseToolCallDeltas(delta?.tool_calls);
    if (toolCalls.length > 0) {
      frame.toolCalls = toolCalls;
    }
    if (parsed.usage) {
      const promptTokens = parsed.usage.prompt_tokens ?? 0;
      const completionTokens = parsed.usage.completion_tokens ?? 0;
      frame.usage = {
        promptTokens,
        completionTokens,
        totalTokens: parsed.usage.total_tokens ?? promptTokens + completionTokens,
      };
    }
    return frame.content === undefined && frame.usage === undefined && frame.toolCalls === undefined
      ? null
      : frame;
  } catch {
    // A non-JSON keepalive/comment line; skip it.
    return null;
  }
}

/** Normalize a raw `delta.tool_calls` array into {@link RawToolCallDelta}s. */
function parseToolCallDeltas(
  raw:
    | ReadonlyArray<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>
    | undefined,
): RawToolCallDelta[] {
  if (!raw) return [];
  const deltas: RawToolCallDelta[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]!;
    // `index` positions the call across frames; fall back to array position when
    // a provider omits it on a single-tool stream.
    const index = typeof entry.index === 'number' ? entry.index : i;
    deltas.push({
      index,
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.function?.name !== undefined ? { name: entry.function.name } : {}),
      ...(entry.function?.arguments !== undefined
        ? { argumentsFragment: entry.function.arguments }
        : {}),
    });
  }
  return deltas;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
