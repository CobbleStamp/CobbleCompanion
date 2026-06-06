/**
 * Dispatch-logic tests: argv parsing and `--dataset` resolution, including the
 * `all` fan-out and unknown-name rejection (the path that makes the CLI exit
 * non-zero). Pure — no network, no run triggered.
 */

import type { Logger } from '@cobble/core';
import { describe, expect, it } from 'vitest';
import type { DatasetReport } from '../framework/dataset.js';
import {
  DATASET_NAMES,
  isKnownDataset,
  parseDataset,
  resolveStatelessNames,
  runStatelessDatasets,
  STATELESS,
} from './dispatch.js';

describe('parseDataset', () => {
  it('defaults to memory-recall with no flag', () => {
    expect(parseDataset(['node', 'eval'])).toBe('memory-recall');
  });

  it('reads the value after --dataset=', () => {
    expect(parseDataset(['node', 'eval', '--dataset=injection'])).toBe('injection');
  });

  it('takes the first --dataset flag when several are given', () => {
    expect(parseDataset(['--dataset=affect-sense', '--dataset=injection'])).toBe('affect-sense');
  });
});

describe('resolveStatelessNames', () => {
  it('expands "all" to every stateless dataset', () => {
    expect(resolveStatelessNames('all')).toEqual(Object.keys(STATELESS));
  });

  it('returns the single name when it is a stateless dataset', () => {
    expect(resolveStatelessNames('injection')).toEqual(['injection']);
  });

  it('returns nothing for memory-recall (it is not a stateless dataset)', () => {
    expect(resolveStatelessNames('memory-recall')).toEqual([]);
  });

  it('returns nothing for an unknown name', () => {
    expect(resolveStatelessNames('nope')).toEqual([]);
  });

  it('every resolved name is a key of the STATELESS map (no drift)', () => {
    for (const name of resolveStatelessNames('all')) {
      expect(STATELESS[name]).toBeDefined();
    }
  });
});

describe('isKnownDataset', () => {
  it('accepts every advertised name', () => {
    for (const name of DATASET_NAMES) {
      expect(isKnownDataset(name)).toBe(true);
    }
  });

  it('rejects an unknown name (drives the non-zero exit)', () => {
    expect(isKnownDataset('memory-recal')).toBe(false);
  });
});

/** A logger that records every error call, so we can assert what was logged. */
class RecordingLogger implements Logger {
  readonly errors: { message: string; meta?: Record<string, unknown> }[] = [];
  error(message: string, meta?: Record<string, unknown>): void {
    this.errors.push({ message, ...(meta ? { meta } : {}) });
  }
  warn(): void {}
  info(): void {}
}

/** A minimal report stub — the loop only forwards reports, it never inspects them. */
function fakeReport(dataset: string, passRate = 1): DatasetReport {
  return { dataset, passRate, meanMetrics: {}, cases: [] };
}

describe('runStatelessDatasets', () => {
  it('returns zero failures and renders every report when all pass', async () => {
    const logger = new RecordingLogger();
    const rendered: string[] = [];
    const failures = await runStatelessDatasets(['affect-sense', 'injection'], {
      runOne: async (name) => fakeReport(name),
      render: (report) => rendered.push(report.dataset),
      logger,
    });
    expect(failures).toBe(0);
    expect(rendered).toEqual(['affect-sense', 'injection']);
    expect(logger.errors).toHaveLength(0);
  });

  it('isolates a thrown dataset: the others still render, and it is counted', async () => {
    const logger = new RecordingLogger();
    const rendered: string[] = [];
    const failures = await runStatelessDatasets(['affect-sense', 'injection'], {
      runOne: async (name) => {
        if (name === 'affect-sense') throw new Error('OpenRouter 503');
        return fakeReport(name);
      },
      render: (report) => rendered.push(report.dataset),
      logger,
    });
    // The thrown dataset is counted as a failure (drives a non-zero exit)...
    expect(failures).toBe(1);
    // ...but the surviving dataset's report is NOT lost.
    expect(rendered).toEqual(['injection']);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toBe('dataset run failed');
    expect(logger.errors[0]?.meta).toMatchObject({
      operation: 'eval.run',
      dataset: 'affect-sense',
    });
  });

  it('counts a report-write failure without aborting the remaining datasets', async () => {
    const logger = new RecordingLogger();
    const written: string[] = [];
    const failures = await runStatelessDatasets(['affect-sense', 'injection'], {
      runOne: async (name) => fakeReport(name),
      render: () => {},
      writeReport: (name) => {
        if (name === 'affect-sense') throw new Error('ENOSPC');
        written.push(name);
      },
      logger,
    });
    expect(failures).toBe(1);
    // The write that failed is counted; the later dataset still wrote.
    expect(written).toEqual(['injection']);
    expect(logger.errors[0]?.message).toBe('failed to write eval report');
    expect(logger.errors[0]?.meta).toMatchObject({
      operation: 'eval.report',
      dataset: 'affect-sense',
    });
  });

  it('does not write reports when no writeReport sink is injected', async () => {
    const logger = new RecordingLogger();
    const failures = await runStatelessDatasets(['affect-sense'], {
      runOne: async (name) => fakeReport(name),
      render: () => {},
      logger,
    });
    expect(failures).toBe(0);
    expect(logger.errors).toHaveLength(0);
  });

  it('returns the total failure count when every dataset fails (any-fail → non-zero)', async () => {
    const logger = new RecordingLogger();
    const failures = await runStatelessDatasets(['affect-sense', 'injection'], {
      runOne: async () => {
        throw new Error('down');
      },
      render: () => {},
      logger,
    });
    expect(failures).toBe(2);
    expect(logger.errors).toHaveLength(2);
  });
});
