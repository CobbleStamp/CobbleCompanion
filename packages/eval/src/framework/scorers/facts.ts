/**
 * Deterministic expected-fact scorer (companionmemory.md §5): passes when every
 * expected fact appears in the output, using the word-boundary-aware match from
 * score.ts. No model — runs in the CI deterministic tier.
 */

import { factPresent } from '../../score.js';
import type { Scorer } from '../scorer.js';

/** Score a string output against a case's `expectedFacts`. */
export function factsScorer<Case extends { readonly expectedFacts: readonly string[] }>(): Scorer<
  Case,
  string
> {
  return {
    name: 'facts',
    async score({ case: evalCase, output }) {
      const total = evalCase.expectedFacts.length;
      const hit = evalCase.expectedFacts.filter((fact) => factPresent(output, fact)).length;
      // Emit a per-case recall ratio (not the raw `total`) so the runner's
      // cross-case mean is meaningful — "mean recall", not "avg facts/case".
      return {
        pass: total > 0 && hit === total,
        metrics: { factsHit: hit, factsRecall: total === 0 ? 0 : hit / total },
        note: `${hit}/${total} expected facts present`,
      };
    },
  };
}
