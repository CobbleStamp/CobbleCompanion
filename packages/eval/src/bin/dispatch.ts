/**
 * Pure dispatch logic for the eval CLI (howto-run-evals.md): argv parsing and
 * the `--dataset` → dataset-name resolution. Kept side-effect-free and separate
 * from `eval.ts` (which auto-runs `main`) so it is unit-testable without touching
 * the network or triggering a run on import.
 */

import { affectSenseDataset } from '../datasets/affect-sense.js';
import { injectionDataset } from '../datasets/injection.js';
import type { Dataset } from '../framework/dataset.js';

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
