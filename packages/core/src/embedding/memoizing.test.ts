/**
 * Tests for the one-entry memoizing embedding gateway. The contract that matters
 * on the hot path: the two RetrieveContext arms embed the same query back-to-back
 * (compose-retrieve.ts), and this wrapper collapses that into a single provider
 * call — returning the same vectors but ZERO usage on the hit so the turn isn't
 * double-metered.
 */

import { describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from './fake.js';
import { createMemoizingEmbeddingGateway } from './memoizing.js';

const QUERY = {
  input: ['what did we do in Lima?'],
  model: 'fake-model',
  dimensions: 8,
} as const;

describe('createMemoizingEmbeddingGateway', () => {
  it('collapses an identical back-to-back call into one provider call', async () => {
    const inner = new FakeEmbeddingGateway();
    const gateway = createMemoizingEmbeddingGateway(inner);

    // Mirrors a turn: episodic arm embeds, then semantic arm embeds the same query.
    const first = await gateway.embed({ ...QUERY });
    const second = await gateway.embed({ ...QUERY });

    expect(inner.calls).toBe(1);
    expect(second.vectors).toEqual(first.vectors);
  });

  it('reports zero usage on the cache hit so the turn is metered once', async () => {
    const inner = new FakeEmbeddingGateway();
    const gateway = createMemoizingEmbeddingGateway(inner);

    const first = await gateway.embed({ ...QUERY });
    const second = await gateway.embed({ ...QUERY });

    expect(first.usage.totalTokens).toBeGreaterThan(0);
    expect(second.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('misses (and makes the real call) when the input differs', async () => {
    const inner = new FakeEmbeddingGateway();
    const gateway = createMemoizingEmbeddingGateway(inner);

    await gateway.embed({ ...QUERY });
    await gateway.embed({ ...QUERY, input: ['a different question'] });

    expect(inner.calls).toBe(2);
  });

  it('keys on model and dimensions, not just the input text', async () => {
    const inner = new FakeEmbeddingGateway();
    const gateway = createMemoizingEmbeddingGateway(inner);

    await gateway.embed({ ...QUERY });
    await gateway.embed({ ...QUERY, model: 'other-model' });
    await gateway.embed({ ...QUERY, dimensions: 16 });

    expect(inner.calls).toBe(3);
  });

  it('holds only the most-recent entry (a new query evicts the prior one)', async () => {
    const inner = new FakeEmbeddingGateway();
    const gateway = createMemoizingEmbeddingGateway(inner);

    await gateway.embed({ ...QUERY }); // A: real
    await gateway.embed({ ...QUERY, input: ['B'] }); // B: real, evicts A
    await gateway.embed({ ...QUERY }); // A again: miss, real

    expect(inner.calls).toBe(3);
  });
});
