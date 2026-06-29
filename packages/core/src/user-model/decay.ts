/**
 * Tier-2 belief-salience POLICY (docs/companion-memory.md §4, Phase 13) — the one place
 * the salience tunables and the formulas that consume them live, so tuning how beliefs
 * are seeded, reinforced, decayed, and ranked never means editing the `user_facts`
 * repository (which only persists/reads). Covers three policies over the stored weight:
 *
 *  - **Decay** — the lazy time-decay *view*. The stored `salience` is the last genuine
 *    reinforcement; both read paths that consult it — the Tier-2 retrieval arm
 *    (`searchBeliefs`) and the motivation engine's interest-sourcing (`topInterestBelief`)
 *    — score it through {@link effectiveSalience} instead. A belief that isn't reinforced
 *    fades on its own; one below {@link STALE_SALIENCE_FLOOR} stops surfacing (never
 *    auto-deleted — it stays visible/forgettable). The view never writes, so a later
 *    reinforce revives the belief from its stored value.
 *  - **Reinforcement** — the seed ({@link DEFAULT_BELIEF_SALIENCE}) and restatement bump
 *    ({@link BELIEF_REINFORCE_STEP}) the store applies on write.
 *  - **Recall ranking** — how effective salience tilts the hybrid fused score
 *    ({@link salienceRankMultiplier}).
 */

/** Uniform half-life of the lazy salience view, in days. Tunable (implementation.md §3). */
export const BELIEF_SALIENCE_HALF_LIFE_DAYS = 30;
/** Below this effective salience a belief is excluded from recall + the engine (not deleted). */
export const STALE_SALIENCE_FLOOR = 0.05;
/** A new Tier-2 belief starts mid-strength; reinforcement/decay move it from here. */
export const DEFAULT_BELIEF_SALIENCE = 0.5;
/** Salience bump when an identical belief is restated (idempotent reinforcement). */
export const BELIEF_REINFORCE_STEP = 0.1;
/**
 * How strongly `salience` tilts hybrid recall ranking (Phase 12). A belief's fused
 * relevance score is multiplied by `1 + WEIGHT * salience`, so salience ∈ [0, 1] maps to
 * a [1, 1 + WEIGHT]× boost. Kept gentle so relevance dominates — salience reorders
 * comparably-relevant hits and breaks near-ties (a reinforced belief rises, a cut one
 * sinks) rather than dragging in beliefs no arm found relevant. Tunable.
 */
const SALIENCE_RANK_WEIGHT = 0.5;

const MS_PER_DAY = 86_400_000;

/**
 * The belief's *effective* salience now: the stored weight decayed by elapsed time since
 * it was last touched (`updatedAt`), on a {@link BELIEF_SALIENCE_HALF_LIFE_DAYS} half-life.
 * A null salience (a Tier-1 row that carries none) reads as 0. Future/zero ages return the
 * stored value unchanged (no decay), so a freshly-written belief is undecayed.
 */
export function effectiveSalience(
  salience: number | null,
  updatedAt: Date,
  now: Date,
  halfLifeDays: number = BELIEF_SALIENCE_HALF_LIFE_DAYS,
): number {
  const stored = salience ?? 0;
  const ageMs = now.getTime() - updatedAt.getTime();
  if (ageMs <= 0 || stored === 0) {
    return stored;
  }
  const ageDays = ageMs / MS_PER_DAY;
  return stored * Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/** Whether a belief's effective salience has decayed below the stale-drop floor. */
export function isStale(effective: number): boolean {
  return effective < STALE_SALIENCE_FLOOR;
}

/**
 * The hybrid-recall rank multiplier for a belief's *effective* salience: `1 + WEIGHT ·
 * effective`, so the fused relevance score is tilted by accumulated strength (a reinforced
 * belief rises, a faded one sinks) without salience ever dominating relevance. The recall
 * ranking policy, kept here rather than in the store's `searchBeliefs`.
 */
export function salienceRankMultiplier(effective: number): number {
  return 1 + SALIENCE_RANK_WEIGHT * effective;
}
