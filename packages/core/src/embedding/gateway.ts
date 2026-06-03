/**
 * Provider-agnostic embedding gateway (architecture.md §3, §5). Semantic memory
 * depends only on this interface; swapping embedding providers never touches
 * retrieval or ingestion. Default impl: OpenRouter (./openrouter.ts); tests use
 * the FakeEmbeddingGateway (./fake.ts).
 */

import type { TokenUsage } from '../usage.js';

export interface EmbeddingParams {
  /** Texts to embed, one vector returned per entry, in order. */
  readonly input: readonly string[];
  readonly model: string;
  /**
   * Output dimensionality — must match the pgvector column dimension
   * (db schema `EMBEDDING_DIMENSIONS`); passed explicitly so a provider/schema
   * mismatch fails fast instead of corrupting the index.
   */
  readonly dimensions: number;
  readonly signal?: AbortSignal;
}

/** Vectors (one per input, in order) plus the call's token usage. */
export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: TokenUsage;
}

/** Typed gateway failure — provider errors surface as data, not raw throws (§4.7). */
export class EmbeddingGatewayError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EmbeddingGatewayError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface EmbeddingGateway {
  /** Embed each input text; resolves to one vector per input (in order) plus usage. */
  embed(params: EmbeddingParams): Promise<EmbeddingResult>;
}
