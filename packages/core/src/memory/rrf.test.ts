/**
 * Unit tests for the generic reciprocal-rank fusion helper shared by the
 * semantic (sections) and episodic (episodes) hybrid retrieval stores.
 */

import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './rrf.js';

interface Item {
  readonly id: string;
}

describe('reciprocalRankFusion', () => {
  const keyOf = (item: Item): string => item.id;

  it('returns [] for empty input', () => {
    expect(reciprocalRankFusion<Item>([], keyOf, 5)).toEqual([]);
    expect(reciprocalRankFusion<Item>([[], []], keyOf, 5)).toEqual([]);
  });

  it('sums scores for an item present in multiple lists (1/61 + 1/61)', () => {
    const fused = reciprocalRankFusion([[{ id: 'both' }], [{ id: 'both' }]], keyOf, 10);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.item.id).toBe('both');
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 61, 12);
  });

  it('scores a rank-0 hit in one list only as 1/61', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }], []], keyOf, 10);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12);
  });

  it('ranks an item in both arms above singletons, and truncates to topK', () => {
    const fused = reciprocalRankFusion(
      [
        [{ id: 'both' }, { id: 'vec' }],
        [{ id: 'both' }, { id: 'lex' }],
      ],
      keyOf,
      2,
    );
    expect(fused).toHaveLength(2);
    expect(fused[0]?.item.id).toBe('both');
  });

  it('keeps the first-seen item object for a shared key', () => {
    const first = { id: 'x', arm: 'vector' };
    const second = { id: 'x', arm: 'lexical' };
    const fused = reciprocalRankFusion([[first], [second]], (i) => i.id, 5);
    expect(fused[0]?.item.arm).toBe('vector');
  });

  it('breaks an equal-score tie by first-seen order (stable sort)', () => {
    // `a` and `b` each sit at rank 0 in a different arm → 1/61 apiece, an exact
    // tie. V8's Array.sort is stable, so equal-score items keep their first-seen
    // (Map insertion) order: `a` (seen in arm 0) precedes `b` (seen in arm 1).
    // A flipped tie-break or an unstable comparator would reorder them — and so
    // would change which item topK truncation drops.
    const fused = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'b' }]], keyOf, 5);
    expect(fused).toHaveLength(2);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 12);
    expect(fused.map((h) => h.item.id)).toEqual(['a', 'b']);
  });

  it('truncates an equal-score tie deterministically by first-seen order', () => {
    // Three first-seen singletons, all tied at 1/61; topK=2 must keep the first
    // two seen (`a`, `b`) and drop `c`. Deterministic only because the sort is
    // stable — an unstable one could surface `c` over `a` or `b`.
    const fused = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'b' }], [{ id: 'c' }]], keyOf, 2);
    expect(fused.map((h) => h.item.id)).toEqual(['a', 'b']);
  });

  it('applies weightOf as a multiplicative prior, re-ranking without injecting items', () => {
    // `a` is rank 0 (1/61) and `b` rank 1 (1/62) in the same arm — `a` wins on
    // relevance alone. A 2× weight on `b` (1/62·2 ≈ 0.0323 > 1/61 ≈ 0.0164) flips
    // the order. The weight only scales items the arm surfaced — it can't add new
    // ones — so the result set is still {a, b}.
    const lists = [[{ id: 'a' }, { id: 'b' }]];
    const weights: Record<string, number> = { a: 1, b: 2 };
    const fused = reciprocalRankFusion(lists, keyOf, 5, undefined, (i) => weights[i.id] ?? 1);
    expect(fused.map((h) => h.item.id)).toEqual(['b', 'a']);
    expect(fused[0]?.score).toBeCloseTo((1 / 62) * 2, 12);
  });
});
