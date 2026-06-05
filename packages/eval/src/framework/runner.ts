/**
 * The dataset runner (companionmemory.md §5): drives every case of a dataset
 * through run → score, then aggregates into a DatasetReport (pass rate + the
 * mean of each metric across cases). Dataset-agnostic — the same loop serves
 * stateless per-call-site datasets and (potentially) stateful ones.
 */

import type { CaseReport, Dataset, DatasetReport, EvalRuntime } from './dataset.js';

/** Run + score every case in a dataset and aggregate the results. */
export async function runDataset<Case extends { readonly id: string }, Output>(
  dataset: Dataset<Case, Output>,
  runtime: EvalRuntime,
): Promise<DatasetReport> {
  const cases: CaseReport[] = [];
  for (const evalCase of dataset.cases) {
    const output = await dataset.run(runtime, evalCase);
    const score = await dataset.scorer.score({ case: evalCase, output });
    cases.push({
      caseId: evalCase.id,
      pass: score.pass,
      metrics: score.metrics,
      note: score.note,
    });
  }
  return {
    dataset: dataset.name,
    passRate: cases.length === 0 ? 0 : cases.filter((report) => report.pass).length / cases.length,
    meanMetrics: meanMetrics(cases),
    cases,
  };
}

/** Average each metric key across the cases that reported it. */
function meanMetrics(cases: readonly CaseReport[]): Readonly<Record<string, number>> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const report of cases) {
    for (const [key, value] of Object.entries(report.metrics)) {
      const acc = sums.get(key) ?? { total: 0, count: 0 };
      sums.set(key, { total: acc.total + value, count: acc.count + 1 });
    }
  }
  const means: Record<string, number> = {};
  for (const [key, { total, count }] of sums) {
    means[key] = count === 0 ? 0 : total / count;
  }
  return means;
}
