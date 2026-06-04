/**
 * Wrap an embedding gateway so identical back-to-back embed requests collapse to
 * one provider call. The composed RetrieveContext hook runs its arms sequentially
 * (harness/compose-retrieve.ts), and every arm embeds the SAME user message with
 * the SAME model + dimensions — episodic recall and semantic recall each embed the
 * turn's query independently. Without this, every chat turn made one redundant
 * embedding round-trip on the request path (doubled query-embedding latency).
 *
 * Scope is a single most-recent entry: the second arm's identical call hits the
 * cache; the next turn's different query evicts it. Memory is bounded to one vector
 * set, and the cache is always correctness-safe — the key pins model, dimensions,
 * and the exact inputs, and embeddings are deterministic, so a hit can only return
 * the vectors the provider would have produced anyway. Under concurrent turns an
 * interleave simply misses and makes the real call — graceful, never wrong.
 *
 * A cache hit reports ZERO usage: only the one real provider call is metered, so a
 * turn is no longer double-charged for the duplicate embed.
 *
 * The memo never aliases its stored vectors: it deep-copies on store and on each
 * hit, so a caller mutating the vectors it received cannot corrupt the entry handed
 * to the next caller.
 */

import { ZERO_USAGE } from '../usage.js';
import type { EmbeddingGateway, EmbeddingParams, EmbeddingResult } from './gateway.js';

/** Stable cache key over the inputs that determine the returned vectors. */
function cacheKey(params: EmbeddingParams): string {
  return JSON.stringify({
    model: params.model,
    dimensions: params.dimensions,
    input: params.input,
  });
}

/**
 * Deep-copy the vector matrix so the cached entry is isolated from its callers.
 * The memo hands the same vectors to every hit; if a caller mutated them in place
 * it would corrupt the entry served to the next caller. Copying on store (the
 * provider's array is no longer aliased by the cache) and on read (each hit gets
 * its own array) makes the cache aliasing-safe in both directions.
 */
function copyVectors(vectors: EmbeddingResult['vectors']): readonly (readonly number[])[] {
  return vectors.map((vector) => [...vector]);
}

/**
 * Decorate `inner` with a one-entry, request-path memo so a turn's two retrieval
 * arms share a single embedding call. Use only where repeated identical embeds are
 * expected (the retrieve-context composition); ingestion embeds distinct chunks and
 * gains nothing.
 */
export function createMemoizingEmbeddingGateway(inner: EmbeddingGateway): EmbeddingGateway {
  let cached: { readonly key: string; readonly vectors: EmbeddingResult['vectors'] } | null = null;
  return {
    async embed(params: EmbeddingParams): Promise<EmbeddingResult> {
      const key = cacheKey(params);
      if (cached !== null && cached.key === key) {
        return { vectors: copyVectors(cached.vectors), usage: ZERO_USAGE };
      }
      const result = await inner.embed(params);
      cached = { key, vectors: copyVectors(result.vectors) };
      return result;
    },
  };
}
