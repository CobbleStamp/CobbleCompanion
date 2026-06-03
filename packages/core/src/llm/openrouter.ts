import { estimateUsage, type TokenUsage } from '../usage.js';
import { type LlmGateway, LlmGatewayError, type LlmStreamParams } from './gateway.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/**
 * OpenRouter-backed gateway. OpenRouter exposes an OpenAI-compatible streaming
 * chat-completions endpoint; we relay `choices[0].delta.content` deltas.
 */
export class OpenRouterGateway implements LlmGateway {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? OPENROUTER_URL;
  }

  async *stream(params: LlmStreamParams): AsyncGenerator<string, TokenUsage, void> {
    const response = await this.requestStream(params);
    const body = response.body;
    if (!body) {
      throw new LlmGatewayError('OpenRouter returned an empty response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: TokenUsage | null = null;
    // If the model omits usage, estimate from the prompt + streamed completion so
    // accounting is never silently zero (architecture.md token budget).
    const fallback = (): TokenUsage =>
      estimateUsage(params.messages.map((message) => message.content).join('\n'), text);
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const frame = parseSseLine(line);
          if (frame === DONE) {
            return usage ?? fallback();
          }
          if (!frame) continue;
          if (frame.content) {
            text += frame.content;
            yield frame.content;
          }
          if (frame.usage) {
            usage = frame.usage;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return usage ?? fallback();
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
          messages: params.messages,
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

/** A parsed SSE data frame: a content delta, a usage report, or both. */
interface SseFrame {
  readonly content?: string;
  readonly usage?: TokenUsage;
}

/** Parse one SSE line into a frame (content and/or usage), DONE, or null to skip. */
function parseSseLine(line: string): SseFrame | typeof DONE | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '[DONE]') return DONE;
  try {
    const parsed = JSON.parse(payload) as {
      choices?: ReadonlyArray<{ delta?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = parsed.choices?.[0]?.delta?.content;
    const frame: { content?: string; usage?: TokenUsage } = {};
    if (typeof content === 'string' && content.length > 0) {
      frame.content = content;
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
    return frame.content === undefined && frame.usage === undefined ? null : frame;
  } catch {
    // A non-JSON keepalive/comment line; skip it.
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
