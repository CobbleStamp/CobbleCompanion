/**
 * Baseline tolerance-band regression tests (companion-memory.md §5). A regression
 * is a drop beyond the band, not any drop — these pin the direction (lower than
 * baseline), the band edge, and that only shared metrics are compared.
 */

import { describe, expect, it } from 'vitest';
import { compareToBaseline, DEFAULT_TOLERANCE } from './baseline.js';
import type { DatasetReport } from './dataset.js';

function report(passRate: number, meanMetrics: Record<string, number>): DatasetReport {
  return { dataset: 'd', passRate, meanMetrics, cases: [] };
}

describe('compareToBaseline', () => {
  it('flags a pass-rate drop beyond the tolerance band', () => {
    const regressions = compareToBaseline(report(0.7, {}), report(0.9, {}));
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ metric: 'passRate', baseline: 0.9, current: 0.7 });
    // delta is signed (current − baseline), so a drop is negative.
    expect(regressions[0]!.delta).toBeCloseTo(-0.2);
  });

  it('does not flag a drop within the tolerance band', () => {
    // Exactly at the edge (drop == tolerance) is NOT a regression (strict >).
    expect(compareToBaseline(report(0.8, {}), report(0.9, {}), 0.1)).toHaveLength(0);
  });

  it('does not flag an improvement', () => {
    expect(compareToBaseline(report(1.0, {}), report(0.5, {}))).toHaveLength(0);
  });

  it('flags each shared mean metric that regressed, by key', () => {
    const regressions = compareToBaseline(
      report(1, { factsRecall: 0.5, grounding: 0.95 }),
      report(1, { factsRecall: 0.9, grounding: 0.96 }),
    );
    expect(regressions.map((r) => r.metric)).toEqual(['mean.factsRecall']);
  });

  it('ignores baseline metrics absent from the current report', () => {
    const regressions = compareToBaseline(report(1, {}), report(1, { gone: 0.9 }));
    expect(regressions).toHaveLength(0);
  });

  it('uses a 10pp default tolerance', () => {
    expect(DEFAULT_TOLERANCE).toBe(0.1);
    // 0.11 drop > default 0.1 → flagged; 0.09 drop ≤ default → not.
    expect(compareToBaseline(report(0.79, {}), report(0.9, {}))).toHaveLength(1);
    expect(compareToBaseline(report(0.81, {}), report(0.9, {}))).toHaveLength(0);
  });
});
