import type { CaseResult, ConfigReport } from './types.js';

/** Aggregate per-case results for one memory configuration into headline metrics. */
export function summarize(
  label: string,
  recentLimit: number,
  results: readonly CaseResult[],
): ConfigReport {
  const recall = results.filter((r) => !r.expectMemoryAbsent);
  const absence = results.filter((r) => r.expectMemoryAbsent);

  return {
    label,
    recentLimit,
    recallPassRate: rate(recall.filter((r) => r.pass).length, recall.length),
    meanGrounding: mean(recall.map((r) => r.grounding)),
    hallucinationRate: rate(absence.filter((r) => r.hallucinated).length, absence.length),
    results,
  };
}

/**
 * The headline "memory vs performance" comparison: one row per memory config so
 * you can see how widening the reachable memory moves recall, grounding, and
 * hallucination.
 */
export function renderComparison(reports: readonly ConfigReport[]): string {
  const header = ['memory config', 'window', 'recall pass', 'grounding', 'halluc. (absent Qs)'];
  const rows = reports.map((report) => [
    report.label,
    String(report.recentLimit),
    pct(report.recallPassRate),
    report.meanGrounding.toFixed(2),
    pct(report.hallucinationRate),
  ]);
  return renderTable(header, rows);
}

/** Per-case detail for a single config, so a surprising score can be traced. */
export function renderCaseDetail(report: ConfigReport): string {
  const header = ['case', 'pass', 'facts', 'grounding', 'halluc.', 'judge reason'];
  const rows = report.results.map((r) => [
    r.caseId,
    r.pass ? 'yes' : 'no',
    `${r.factsHit}/${r.factsTotal}`,
    r.grounding.toFixed(2),
    r.hallucinated ? 'yes' : 'no',
    truncate(r.judgeReason, 60),
  ]);
  return `\n${report.label} (window ${report.recentLimit})\n${renderTable(header, rows)}`;
}

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, col) =>
    Math.max(cell.length, ...rows.map((row) => (row[col] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ');
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(header), divider, ...rows.map(line)].join('\n');
}

function rate(hits: number, total: number): number {
  return total === 0 ? 0 : hits / total;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
