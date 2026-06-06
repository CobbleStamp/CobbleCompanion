/**
 * Dispatch-logic tests: argv parsing and `--dataset` resolution, including the
 * `all` fan-out and unknown-name rejection (the path that makes the CLI exit
 * non-zero). Pure — no network, no run triggered.
 */

import { describe, expect, it } from 'vitest';
import {
  DATASET_NAMES,
  isKnownDataset,
  parseDataset,
  resolveStatelessNames,
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
