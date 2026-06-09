/**
 * Single source of truth for rendering a Tier-2 belief as natural language — shared by
 * the WRITE side (the text a belief is embedded under when stored) and the READ side
 * (the visible "what I know about you" recall line). Keeping both on the same phrasing is
 * what makes belief recall *symmetric*: a belief is embedded as the same kind of prose it
 * is later recalled against (a full user-turn sentence), so cosine distance reflects
 * topical overlap rather than a format gap. Embedding the terse `predicate object` tag
 * instead (e.g. "interestedIn jazz") leaves the stored vector in a different register from
 * the natural-language query, inflating distance and letting the relevance floor drop
 * genuinely relevant beliefs.
 *
 * Used by: harness.ts / reflector.ts (write — embedding text) and
 * harness/user-model-retrieve.ts (read — recall block line).
 */

/** Natural phrasing for each Tier-2 belief predicate; falls back to the predicate itself. */
const BELIEF_PHRASING: Readonly<Record<string, string>> = {
  prefers: 'prefers',
  dislikes: 'dislikes',
  interestedIn: 'is interested in',
  believes: 'believes',
};

/**
 * Render a belief as a natural-language clause — e.g. ('interestedIn', 'jazz') →
 * "the user is interested in jazz". The same rendering is used to embed the belief and to
 * surface it in the recall block, so the two stay in lockstep.
 */
export function beliefPhrase(predicate: string | undefined | null, object: string): string {
  const phrase = BELIEF_PHRASING[predicate ?? ''] ?? predicate ?? 'about';
  return `the user ${phrase} ${object}`;
}
