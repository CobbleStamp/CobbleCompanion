/**
 * Reciprocal-rank fusion (RRF) — the scale-free way to merge several ranked
 * result lists into one. An item's fused score is Σ over the lists of
 * 1/(K + rank + 1), so a vector arm's cosine distances and a lexical arm's
 * ts_rank scores combine without ever being calibrated against each other.
 *
 * Shared by both hybrid retrieval stores: semantic (sections, Phase 1) and
 * episodic (episodes, Phase 2). Pure computation, separated from SQL for
 * direct unit testing.
 */

/** The conventional RRF dampening constant (Cormack et al., 2009). */
export const RRF_K = 60;

/**
 * Fuse ranked `lists` by RRF. `keyOf` identifies the same item across lists
 * (so a hit appearing in multiple arms accumulates score); the FIRST-seen item
 * object for a key is kept. Returns the top `topK` items with their fused score,
 * highest first.
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  topK: number,
  k: number = RRF_K,
): readonly { readonly item: T; readonly score: number }[] {
  const fused = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const key = keyOf(item);
      const increment = 1 / (k + rank + 1);
      const existing = fused.get(key);
      if (existing) {
        fused.set(key, { item: existing.item, score: existing.score + increment });
      } else {
        fused.set(key, { item, score: increment });
      }
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}
