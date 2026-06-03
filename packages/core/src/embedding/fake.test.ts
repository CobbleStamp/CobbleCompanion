/** Tests for the deterministic fake embedding gateway. */

import { describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway, hashToUnitVector } from './fake.js';

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

describe('hashToUnitVector', () => {
  it('is deterministic: identical input yields the identical vector', () => {
    const a = hashToUnitVector('ceviche history in Lima', 64);
    const b = hashToUnitVector('ceviche history in Lima', 64);
    expect(a).toEqual(b);
  });

  it('produces unit-length vectors', () => {
    for (const text of ['Peru', 'a longer paragraph about trains in Cusco', '']) {
      const v = hashToUnitVector(text, 32);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
  });

  it('separates different texts (self-similarity beats cross-similarity)', () => {
    const ceviche = hashToUnitVector('ceviche history in Lima', 64);
    const trains = hashToUnitVector('train schedules in Cusco', 64);
    expect(cosine(ceviche, ceviche)).toBeGreaterThan(cosine(ceviche, trains));
  });

  it('respects the requested dimensionality', () => {
    expect(hashToUnitVector('x', 16)).toHaveLength(16);
    expect(hashToUnitVector('x', 1024)).toHaveLength(1024);
  });
});

describe('FakeEmbeddingGateway', () => {
  it('returns one vector per input, in order, and records params', async () => {
    const gateway = new FakeEmbeddingGateway();
    const vectors = await gateway.embed({
      input: ['first', 'second'],
      model: 'fake-model',
      dimensions: 8,
    });

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual(hashToUnitVector('first', 8));
    expect(vectors[1]).toEqual(hashToUnitVector('second', 8));
    expect(gateway.lastParams?.model).toBe('fake-model');
  });
});
