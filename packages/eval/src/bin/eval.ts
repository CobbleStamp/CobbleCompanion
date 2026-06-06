/**
 * Eval CLI entrypoint (companion-memory.md §5, howto-run-evals.md). Dispatches to
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
import { consoleLogger, OpenRouterGateway } from '@cobble/core';
import type { DatasetReport, EvalRuntime } from '../framework/dataset.js';
import { runDataset } from '../framework/runner.js';
import { runMemoryRecallEval } from '../run.js';
import {
  DATASET_NAMES,
  isKnownDataset,
  parseDataset,
  resolveStatelessNames,
  runStatelessDatasets,
  STATELESS,
} from './dispatch.js';

// A real logger (writes errors/warnings to stderr) — NOT a silent one. A live
// eval that swallowed the senseAffect failure path would score a null read as
// "safe" with no trail; we must see what broke (logging.md).
const logger = consoleLogger;

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
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
  if (!isKnownDataset(which)) {
    throw new Error(`unknown dataset "${which}" (expected: ${DATASET_NAMES.join(' | ')})`);
  }
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (apiKey.length === 0) {
    throw new Error(
      'OPENROUTER_API_KEY is required — this is a LIVE eval against OpenRouter (companion-memory.md).',
    );
  }
  const model = process.env.LLM_MODEL ?? 'anthropic/claude-3.5-sonnet';

  if (which === 'memory-recall' || which === 'all') {
    await runMemoryRecallEval();
  }

  const statelessNames = resolveStatelessNames(which);
  if (statelessNames.length === 0) {
    return;
  }
  const runtime: EvalRuntime = {
    gateway: new OpenRouterGateway({ apiKey }),
    model,
    logger,
  };
  // When EVAL_REPORT_DIR is set (the nightly tier), also write the machine-
  // readable DatasetReport JSON. The nightly uploads these as artifacts; diffing
  // them against a baseline (compareToBaseline) is currently a manual/offline
  // step, not an automated gate — see docs/howto-run-evals.md.
  const reportDir = process.env.EVAL_REPORT_DIR;
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
  }
  // The error-isolation run loop lives in dispatch.ts (runStatelessDatasets) so it
  // is unit-testable with fakes. Here we just inject the live side effects: run a
  // dataset over real OpenRouter, print its report, and — when EVAL_REPORT_DIR is
  // set — write its machine-readable JSON.
  const failures = await runStatelessDatasets(statelessNames, {
    runOne: (name) => runDataset(STATELESS[name]!, runtime),
    render: (report) => out(renderReport(report)),
    ...(reportDir
      ? {
          writeReport: (name: string, report: DatasetReport): void => {
            writeFileSync(join(reportDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
          },
        }
      : {}),
    logger,
  });
  if (failures > 0) {
    throw new Error(`${failures} dataset(s) failed — see logged errors above`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
