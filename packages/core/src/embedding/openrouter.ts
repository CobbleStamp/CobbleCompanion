/**
 * OpenRouter-backed embedding gateway. OpenRouter exposes an OpenAI-compatible
 * embeddings endpoint (`POST /api/v1/embeddings`: model, input, dimensions);
 * we relay `data[].embedding` vectors re-ordered by `data[].index`.
 */

import { estimateTokens, type TokenUsage } from '../usage.js';
import {
  type EmbeddingGateway,
  EmbeddingGatewayError,
  type EmbeddingParams,
  type EmbeddingResult,
} from './gateway.js';

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

export interface OpenRouterEmbeddingConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

interface EmbeddingResponseItem {
  readonly index?: number;
  readonly embedding?: readonly number[];
}

/** OpenRouter embeddings client implementing the provider-agnostic gateway. */
export class OpenRouterEmbeddingGateway implements EmbeddingGateway {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenRouterEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? OPENROUTER_EMBEDDINGS_URL;
  }

  async embed(params: EmbeddingParams): Promise<EmbeddingResult> {
    if (params.input.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
    const response = await this.request(params);
    const payload = (await response.json().catch((cause: unknown) => {
      throw new EmbeddingGatewayError('OpenRouter returned non-JSON embeddings body', cause);
    })) as {
      data?: readonly EmbeddingResponseItem[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    const items = payload.data;
    if (!items || items.length !== params.input.length) {
      throw new EmbeddingGatewayError(
        `OpenRouter returned ${items?.length ?? 0} embeddings for ${params.input.length} inputs`,
      );
    }

    const vectors: (readonly number[])[] = new Array(params.input.length);
    for (const item of items) {
      const { index, embedding } = item;
      if (index === undefined || index < 0 || index >= params.input.length || !embedding) {
        throw new EmbeddingGatewayError('OpenRouter returned a malformed embedding item');
      }
      if (embedding.length !== params.dimensions) {
        throw new EmbeddingGatewayError(
          `OpenRouter returned ${embedding.length}-dim embedding; expected ${params.dimensions}`,
        );
      }
      // A duplicate index would pass the count check yet leave another slot an
      // array hole, persisting `undefined` downstream — reject it here. With
      // counts equal and every index in-range and unique, all slots are filled.
      if (vectors[index] !== undefined) {
        throw new EmbeddingGatewayError(`OpenRouter returned a duplicate embedding index ${index}`);
      }
      vectors[index] = embedding;
    }
    return { vectors, usage: toUsage(payload.usage, params.input) };
  }

  private async request(params: EmbeddingParams): Promise<Response> {
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
          input: params.input,
          dimensions: params.dimensions,
        }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (cause) {
      throw new EmbeddingGatewayError('OpenRouter embeddings request failed', cause);
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new EmbeddingGatewayError(
        `OpenRouter embeddings responded ${response.status}: ${detail}`,
      );
    }
    return response;
  }
}

/**
 * Embedding usage from the response (prompt-only; no completion), estimating
 * from the inputs when the provider omits it so accounting is never silently 0.
 * `totalTokens` is derived from `promptTokens` rather than trusted from the
 * provider: embeddings have no completion tokens, and a provider returning
 * `total_tokens: 0` alongside real `prompt_tokens` must not zero the daily-cap
 * debit.
 */
function toUsage(
  usage: { prompt_tokens?: number; total_tokens?: number } | undefined,
  input: readonly string[],
): TokenUsage {
  const promptTokens =
    usage?.prompt_tokens ?? usage?.total_tokens ?? estimateTokens(input.join('\n'));
  return { promptTokens, completionTokens: 0, totalTokens: promptTokens };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
