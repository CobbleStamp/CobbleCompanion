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
 *
 * `weightOf` is an optional per-item multiplier applied to the fused score before
 * ranking — a *prior* over the relevance arms, NOT another arm. It re-weights only
 * items the arms already surfaced (it cannot inject an item that no arm ranked), so
 * it tilts ordering without polluting recall. The User-Model store uses it to let a
 * reinforced belief's `salience` lift it among equally-relevant hits (Phase 12).
 * Defaults to a flat 1 → pure relevance (semantic/episodic callers, Phases 1–2).
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  topK: number,
  k: number = RRF_K,
  weightOf: (item: T) => number = () => 1,
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
  return [...fused.values()]
    .map(({ item, score }) => ({ item, score: score * weightOf(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
