/**
 * Pure dispatch logic for the eval CLI (howto-run-evals.md): argv parsing and
 * the `--dataset` → dataset-name resolution. Kept side-effect-free and separate
 * from `eval.ts` (which auto-runs `main`) so it is unit-testable without touching
 * the network or triggering a run on import.
 */

import type { Logger } from '@cobble/core';
import { affectSenseDataset } from '../datasets/affect-sense.js';
import { injectionDataset } from '../datasets/injection.js';
import type { Dataset, DatasetReport } from '../framework/dataset.js';

/** The stateless datasets, by `--dataset` name (the generic-framework tier). */
export const STATELESS: Record<string, Dataset<{ readonly id: string }, unknown>> = {
  'affect-sense': affectSenseDataset as Dataset<{ readonly id: string }, unknown>,
  injection: injectionDataset as Dataset<{ readonly id: string }, unknown>,
};

/** All accepted `--dataset` values, for arg validation + the usage message. */
export const DATASET_NAMES: readonly string[] = ['memory-recall', ...Object.keys(STATELESS), 'all'];

/** Read `--dataset=<name>` from argv; default `memory-recall`. */
export function parseDataset(argv: readonly string[]): string {
  const flag = argv.find((arg) => arg.startsWith('--dataset='));
  return flag ? flag.slice('--dataset='.length) : 'memory-recall';
}

/** The stateless dataset names selected by a `--dataset` value (pure; testable). */
export function resolveStatelessNames(which: string): readonly string[] {
  if (which === 'all') return Object.keys(STATELESS);
  return which in STATELESS ? [which] : [];
}

/** Whether a `--dataset` value names something runnable at all. */
export function isKnownDataset(which: string): boolean {
  return which === 'memory-recall' || which === 'all' || which in STATELESS;
}

/**
 * Injected dependencies for the stateless run loop — kept abstract so the loop is
 * testable without touching the network, the filesystem, or stdout. `runOne`
 * produces a dataset's report (live: `runDataset` over OpenRouter; tests: a fake);
 * `render` is called per successful report (live: print to stdout); `writeReport`
 * is the optional report-JSON sink (live: write a file when EVAL_REPORT_DIR is set;
 * omit it to skip writing). All side effects live behind these hooks.
 */
export interface StatelessRunDeps {
  readonly runOne: (name: string) => Promise<DatasetReport>;
  readonly render: (report: DatasetReport) => void;
  readonly writeReport?: (name: string, report: DatasetReport) => void;
  readonly logger: Logger;
}

/**
 * Run each named stateless dataset independently and return the failure count.
 *
 * Error isolation is the whole point: one dataset throwing (a live API hiccup) is
 * logged and counted but must NOT lose the reports of the others, and a report
 * WRITE failure is likewise logged + counted without aborting the run. A non-zero
 * return means at least one dataset failed (the CLI turns that into a non-zero
 * exit); zero means every dataset ran and wrote cleanly.
 */
export async function runStatelessDatasets(
  names: readonly string[],
  deps: StatelessRunDeps,
): Promise<number> {
  let failures = 0;
  for (const name of names) {
    try {
      const report = await deps.runOne(name);
      deps.render(report);
      if (deps.writeReport) {
        try {
          deps.writeReport(name, report);
        } catch (error) {
          failures += 1;
          deps.logger.error('failed to write eval report', {
            operation: 'eval.report',
            dataset: name,
            error,
          });
        }
      }
    } catch (error) {
      failures += 1;
      deps.logger.error('dataset run failed', { operation: 'eval.run', dataset: name, error });
    }
  }
  return failures;
}
