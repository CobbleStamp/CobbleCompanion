/**
 * Affect-sense quality dataset (companion-motivation.md §7): does the companion
 * read the SIGN of the user's mood correctly? Each case is one user message with
 * an unambiguous expected valence sign; the dataset runs the real `senseAffect`
 * call site against OpenRouter and scores whether the reported valence matches.
 * Stateless (no DB) — a thin per-call-site eval that isolates prompt quality.
 */

import { type AffectReading, senseAffect } from '@cobble/core';
import type { Dataset, EvalRuntime } from '../framework/dataset.js';
import type { Scorer } from '../framework/scorer.js';

/** One mood-read case: a message and the valence sign a correct read should have. */
export interface AffectCase {
  readonly id: string;
  readonly userText: string;
  readonly expectedSign: 'positive' | 'negative';
}

const CASES: readonly AffectCase[] = [
  {
    id: 'delighted',
    userText: 'This is amazing, thank you so much — you nailed it!',
    expectedSign: 'positive',
  },
  {
    id: 'grateful',
    userText: 'honestly that really helped, I feel so much better now',
    expectedSign: 'positive',
  },
  {
    id: 'frustrated',
    userText: "this is the third time it's broken and I'm sick of it",
    expectedSign: 'negative',
  },
  {
    id: 'deflated',
    userText: "i give up. nothing I try works and I'm exhausted.",
    expectedSign: 'negative',
  },
];

/** Pass when a non-null read's valence sign matches the case's expected sign. */
function valenceSignScorer(): Scorer<AffectCase, AffectReading | null> {
  return {
    name: 'valence-sign',
    async score({ case: evalCase, output }) {
      if (!output) {
        return { pass: false, metrics: { valence: 0 }, note: 'no read (null)' };
      }
      const sign = output.valence > 0 ? 'positive' : output.valence < 0 ? 'negative' : 'neutral';
      return {
        pass: sign === evalCase.expectedSign,
        metrics: { valence: output.valence },
        note: `read ${output.valence.toFixed(2)} (${sign}); expected ${evalCase.expectedSign}`,
      };
    },
  };
}

export const affectSenseDataset: Dataset<AffectCase, AffectReading | null> = {
  name: 'affect-sense',
  cases: CASES,
  run: (runtime: EvalRuntime, evalCase) =>
    senseAffect(
      { llm: runtime.gateway, model: runtime.model, logger: runtime.logger },
      { recentContext: '', userText: evalCase.userText },
    ),
  scorer: valenceSignScorer(),
};
