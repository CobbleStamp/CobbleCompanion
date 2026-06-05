/**
 * Dataset + runtime contracts for the eval framework (companionmemory.md §5). A
 * Dataset bundles its cases, how to produce an output for one case (a call into
 * core, against real OpenRouter — or a fake in tests), and the scorer that
 * judges that output. The runner (runner.ts) drives any dataset uniformly.
 */

import type { LlmGateway, Logger } from '@cobble/core';
import type { Scorer } from './scorer.js';

/** Shared dependencies a dataset's `run` uses to produce outputs. */
export interface EvalRuntime {
  /** Real OpenRouter for live runs; a FakeLlmGateway in deterministic tests. */
  readonly gateway: LlmGateway;
  readonly model: string;
  readonly logger: Logger;
}

/** A self-contained evaluation: cases, how to run one, and how to score it. */
export interface Dataset<Case extends { readonly id: string }, Output> {
  readonly name: string;
  readonly cases: readonly Case[];
  run(runtime: EvalRuntime, evalCase: Case): Promise<Output>;
  readonly scorer: Scorer<Case, Output>;
}

/** One case's outcome after running + scoring. */
export interface CaseReport {
  readonly caseId: string;
  readonly pass: boolean;
  readonly metrics: Readonly<Record<string, number>>;
  readonly note: string;
}

/** A dataset's aggregate outcome: pass rate + per-metric means + per-case detail. */
export interface DatasetReport {
  readonly dataset: string;
  readonly passRate: number;
  readonly meanMetrics: Readonly<Record<string, number>>;
  readonly cases: readonly CaseReport[];
}
