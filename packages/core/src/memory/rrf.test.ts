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
});
