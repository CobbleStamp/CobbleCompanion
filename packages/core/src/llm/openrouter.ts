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

  async *stream(params: LlmStreamParams): AsyncIterable<string> {
    const response = await this.requestStream(params);
    const body = response.body;
    if (!body) {
      throw new LlmGatewayError('OpenRouter returned an empty response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const delta = parseSseLine(line);
          if (delta === DONE) return;
          if (delta) yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
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

/** Parse one SSE line into a content delta, the DONE sentinel, or null to skip. */
function parseSseLine(line: string): string | typeof DONE | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '[DONE]') return DONE;
  try {
    const parsed = JSON.parse(payload) as {
      choices?: ReadonlyArray<{ delta?: { content?: string } }>;
    };
    return parsed.choices?.[0]?.delta?.content ?? null;
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
