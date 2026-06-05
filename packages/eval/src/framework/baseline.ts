/**
 * Baseline regression comparison (companionmemory.md §5). LLM outputs are
 * nondeterministic, so a regression is a drop beyond a tolerance BAND, not an
 * inequality. A baseline is the machine-readable DatasetReport from a prior run
 * (committed under docs/eval/<dataset>-<date>.json); compareToBaseline flags
 * pass-rate or mean-metric regressions for the nightly live tier to fail on.
 */

import type { DatasetReport } from './dataset.js';

/** Default tolerance: allow a 0.1 (10pp) drop before calling it a regression. */
export const DEFAULT_TOLERANCE = 0.1;

/** One flagged regression: what dropped, by how much. */
export interface Regression {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
}

/**
 * Compare a current report to a baseline. Flags passRate and each shared mean
 * metric that fell by more than `tolerance`. Higher-is-better is assumed (the
 * current metrics are recall/grounding-style); invert the sign before calling
 * for lower-is-better metrics if ever needed.
 */
export function compareToBaseline(
  current: DatasetReport,
  baseline: DatasetReport,
  tolerance: number = DEFAULT_TOLERANCE,
): readonly Regression[] {
  const regressions: Regression[] = [];
  const check = (metric: string, base: number, now: number): void => {
    if (base - now > tolerance) {
      regressions.push({ metric, baseline: base, current: now, delta: now - base });
    }
  };
  check('passRate', baseline.passRate, current.passRate);
  for (const [key, baseValue] of Object.entries(baseline.meanMetrics)) {
    const nowValue = current.meanMetrics[key];
    if (typeof nowValue === 'number') {
      check(`mean.${key}`, baseValue, nowValue);
    }
  }
  return regressions;
}
