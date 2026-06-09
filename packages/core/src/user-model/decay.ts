/**
 * Lazy time-decay of Tier-2 belief salience (docs/companion-memory.md §4, Phase 13).
 *
 * Forgetting is the tail of decay, not a sweeper: the stored `salience` is the last
 * genuine reinforcement, and both read paths that consult it — the Tier-2 retrieval arm
 * (`searchBeliefs`) and the motivation engine's interest-sourcing (`topInterestBelief`) —
 * score it through this one pure function instead. A belief that hasn't been reinforced
 * fades on its own; one whose effective salience falls below {@link STALE_SALIENCE_FLOOR}
 * stops surfacing (but is never auto-deleted — it stays visible/forgettable). Decay is a
 * *view*: it never writes, so a later `reinforce` revives the belief from its stored value.
 */

/** Uniform half-life of the lazy salience view, in days. Tunable (implementation.md §3). */
export const BELIEF_SALIENCE_HALF_LIFE_DAYS = 30;
/** Below this effective salience a belief is excluded from recall + the engine (not deleted). */
export const STALE_SALIENCE_FLOOR = 0.05;

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
