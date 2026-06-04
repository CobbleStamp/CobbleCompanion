/**
 * Tests for the one-entry memoizing embedding gateway. The contract that matters
 * on the hot path: the two RetrieveContext arms embed the same query back-to-back
 * (compose-retrieve.ts), and this wrapper collapses that into a single provider
 * call — returning the same vectors but ZERO usage on the hit so the turn isn't
 * double-metered.
 */

import { describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from './fake.js';
import type { EmbeddingGateway, EmbeddingParams, EmbeddingResult } from './gateway.js';
import { createMemoizingEmbeddingGateway } from './memoizing.js';

const QUERY = {
  input: ['what did we do in Lima?'],
  model: 'fake-model',
  dimensions: 8,
} as const;

/**
 * Gateway whose embed() blocks on a manually-resolved gate, so a test can hold two
 * concurrent calls in flight before either populates the cache. Returns the same
 * deterministic vectors the FakeEmbeddingGateway would, and counts invocations.
 */
class GatedEmbeddingGateway implements EmbeddingGateway {
  calls = 0;
  private readonly gate: Promise<void>;
  private readonly real = new FakeEmbeddingGateway();

  constructor(gate: Promise<void>) {
    this.gate = gate;
  }

  async embed(params: EmbeddingParams): Promise<EmbeddingResult> {
    this.calls++;
    await this.gate;
    return this.real.embed(params);
  }
}

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

  it('returns correct vectors to both racers when two identical calls interleave before the cache is populated', async () => {
    // Hold both calls in flight before either writes the cache, forcing the
    // documented interleave: the dedup is missed, but neither result is wrong.
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const inner = new GatedEmbeddingGateway(gate);
    const gateway = createMemoizingEmbeddingGateway(inner);

    // The expected answer the provider would deterministically produce.
    const expected = await new FakeEmbeddingGateway().embed({ ...QUERY });

    const firstPromise = gateway.embed({ ...QUERY });
    const secondPromise = gateway.embed({ ...QUERY });
    openGate();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    // Both racers get the correct vectors — never a blended or wrong result.
    expect(first.vectors).toEqual(expected.vectors);
    expect(second.vectors).toEqual(expected.vectors);
    // An interleave only misses the dedup; the real call ran once or twice.
    expect(inner.calls).toBeGreaterThanOrEqual(1);
    expect([1, 2]).toContain(inner.calls);
  });

  it('isolates cached vectors from a caller that mutates the result it received', async () => {
    const inner = new FakeEmbeddingGateway();
    const gateway = createMemoizingEmbeddingGateway(inner);

    const first = await gateway.embed({ ...QUERY });
    const expected = await new FakeEmbeddingGateway().embed({ ...QUERY });

    // A misbehaving caller mutates the vectors it got back. The readonly typing
    // forbids this, so cast to a mutable view to simulate the bad caller.
    const rogue = first.vectors as number[][];
    rogue[0]?.splice(0, rogue[0].length);
    rogue.push([42, 42, 42]);

    // The next caller (a cache hit) must still see the correct, un-mutated vectors.
    const second = await gateway.embed({ ...QUERY });
    expect(second.vectors).toEqual(expected.vectors);
    // And the hit is still metered as zero usage.
    expect(second.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});
