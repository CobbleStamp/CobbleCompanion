/**
 * Deterministic in-memory embedding gateway for tests and offline dev
 * (EMBEDDING_PROVIDER=fake). Hashes each input into a reproducible unit vector:
 * identical texts embed identically (cosine distance 0) and different texts
 * almost surely differ, so retrieval-ranking tests exercise real ordering logic.
 * Per testing.md, we fake the gateway interface rather than mock the real client.
 */

import { estimateTokens } from '../usage.js';
import type { EmbeddingGateway, EmbeddingParams, EmbeddingResult } from './gateway.js';

export class FakeEmbeddingGateway implements EmbeddingGateway {
  lastParams: EmbeddingParams | null = null;
  /** Number of times embed() actually ran — lets tests assert call dedup. */
  calls = 0;

  async embed(params: EmbeddingParams): Promise<EmbeddingResult> {
    this.lastParams = params;
    this.calls++;
    const promptTokens = estimateTokens(params.input.join('\n'));
    return {
      vectors: params.input.map((text) => hashToUnitVector(text, params.dimensions)),
      usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
    };
  }
}

/**
 * Fold a string into a deterministic unit vector of the given dimensionality.
 * Each character perturbs a hash-selected component, then the vector is
 * L2-normalized so cosine comparisons behave like real embeddings.
 */
export function hashToUnitVector(text: string, dimensions: number): readonly number[] {
  const vector: number[] = new Array<number>(dimensions).fill(0);
  // FNV-1a style rolling hash drives which component each character perturbs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    const slot = Math.abs(hash) % dimensions;
    // Signed contribution keeps vectors spread across the space.
    vector[slot] = (vector[slot] ?? 0) + (hash % 2 === 0 ? 1 : -1);
  }
  let norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    // Degenerate (e.g. empty string): a fixed basis vector keeps the result unit-length.
    vector[0] = 1;
    norm = 1;
  }
  return vector.map((v) => v / norm);
}
