/**
 * The scorer abstraction (companion-memory.md §5). A Scorer turns a (case, output)
 * pair into named signals: a pass/fail, numeric metrics (aggregated across cases
 * by the runner), and a human note. Deterministic scorers (facts, refusal) need
 * no model and run in CI; an LLM-judge scorer spends real tokens (live tier).
 */

/** The signals one scorer produces for one case. */
export interface ScoreResult {
  readonly pass: boolean;
  /** Named numeric signals; the runner averages each across the dataset. */
  readonly metrics: Readonly<Record<string, number>>;
  /** Human-readable detail — a judge reason or a failure explanation. */
  readonly note: string;
}

/** Scores one case's output. Always async (deterministic scorers just don't await). */
export interface Scorer<Case, Output> {
  readonly name: string;
  score(input: { readonly case: Case; readonly output: Output }): Promise<ScoreResult>;
}

/** Combine scorers: pass = all pass, metrics merged, notes joined. */
export function composeScorers<Case, Output>(
  scorers: readonly Scorer<Case, Output>[],
): Scorer<Case, Output> {
  return {
    name: scorers.map((scorer) => scorer.name).join('+'),
    async score(input) {
      const results = await Promise.all(scorers.map((scorer) => scorer.score(input)));
      return {
        pass: results.every((result) => result.pass),
        metrics: Object.assign({}, ...results.map((result) => result.metrics)),
        note: results
          .map((result) => result.note)
          .filter((note) => note.length > 0)
          .join('; '),
      };
    },
  };
}
