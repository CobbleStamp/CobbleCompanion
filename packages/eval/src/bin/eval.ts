/**
 * Eval CLI entrypoint (companionmemory.md §5, howto-run-evals.md). Dispatches to
 * one dataset (or all) against REAL OpenRouter and prints the report. The
 * stateful memory-recall eval keeps its bespoke multi-config runner; the
 * stateless per-call-site datasets go through the generic framework runner.
 *
 *   pnpm eval                       # memory-recall (default)
 *   pnpm eval --dataset=affect-sense
 *   pnpm eval --dataset=injection
 *   pnpm eval --dataset=all
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Logger, OpenRouterGateway } from '@cobble/core';
import { affectSenseDataset } from '../datasets/affect-sense.js';
import { injectionDataset } from '../datasets/injection.js';
import type { Dataset, DatasetReport, EvalRuntime } from '../framework/dataset.js';
import { runDataset } from '../framework/runner.js';
import { runMemoryRecallEval } from '../run.js';

/** The stateless datasets, by `--dataset` name. */
const STATELESS: Record<string, Dataset<{ readonly id: string }, unknown>> = {
  'affect-sense': affectSenseDataset as Dataset<{ readonly id: string }, unknown>,
  injection: injectionDataset as Dataset<{ readonly id: string }, unknown>,
};

const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {} };

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Read `--dataset=<name>` from argv; default `memory-recall`. */
function parseDataset(argv: readonly string[]): string {
  const flag = argv.find((arg) => arg.startsWith('--dataset='));
  return flag ? flag.slice('--dataset='.length) : 'memory-recall';
}

/** Render a stateless dataset's report as a compact, human-readable block. */
function renderReport(report: DatasetReport): string {
  const metrics = Object.entries(report.meanMetrics)
    .map(([key, value]) => `${key}=${value.toFixed(2)}`)
    .join(' ');
  const lines = [
    `\n=== ${report.dataset} ===`,
    `pass rate: ${(report.passRate * 100).toFixed(0)}%  (${metrics})`,
    ...report.cases.map(
      (caseReport) =>
        `  ${caseReport.pass ? 'PASS' : 'FAIL'}  ${caseReport.caseId} — ${caseReport.note}`,
    ),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const which = parseDataset(process.argv);
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY is required — this is a LIVE eval against OpenRouter (companionmemory.md).',
    );
  }
  const model = process.env.LLM_MODEL ?? 'anthropic/claude-3.5-sonnet';

  if (which === 'memory-recall' || which === 'all') {
    await runMemoryRecallEval();
  }

  const statelessNames =
    which === 'all' ? Object.keys(STATELESS) : which in STATELESS ? [which] : [];
  if (statelessNames.length > 0) {
    const runtime: EvalRuntime = {
      gateway: new OpenRouterGateway({ apiKey }),
      model,
      logger: silentLogger,
    };
    // When EVAL_REPORT_DIR is set (the nightly tier), also write the machine-
    // readable DatasetReport JSON — the baseline artifact compareToBaseline diffs.
    const reportDir = process.env.EVAL_REPORT_DIR;
    if (reportDir) {
      mkdirSync(reportDir, { recursive: true });
    }
    for (const name of statelessNames) {
      const report = await runDataset(STATELESS[name]!, runtime);
      out(renderReport(report));
      if (reportDir) {
        writeFileSync(join(reportDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
      }
    }
  }

  if (which !== 'memory-recall' && which !== 'all' && statelessNames.length === 0) {
    throw new Error(
      `unknown dataset "${which}" (expected: memory-recall | affect-sense | injection | all)`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
