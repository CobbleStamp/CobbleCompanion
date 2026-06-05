/** Drive-level computation (v1: curiosity from the lead frontier) + weight resolution. */

import { describe, expect, it } from 'vitest';
import { computeDrives, DEFAULT_DRIVE_WEIGHTS, resolveWeights } from './drives.js';

describe('computeDrives', () => {
  it('raises curiosity with unread leads, saturating at 1', () => {
    expect(computeDrives({ newLeadCount: 0 }).curiosity).toBe(0);
    expect(computeDrives({ newLeadCount: 1 }).curiosity).toBeCloseTo(0.2);
    expect(computeDrives({ newLeadCount: 5 }).curiosity).toBe(1);
    expect(computeDrives({ newLeadCount: 20 }).curiosity).toBe(1);
  });

  it('keeps the non-v1 drives at zero', () => {
    const levels = computeDrives({ newLeadCount: 3 });
    expect(levels.bond).toBe(0);
    expect(levels.understanding).toBe(0);
    expect(levels.approval).toBe(0);
    expect(levels.helpfulness).toBe(0);
    expect(levels.upkeep).toBe(0);
  });

  it('treats a negative count as zero', () => {
    expect(computeDrives({ newLeadCount: -3 }).curiosity).toBe(0);
  });
});

describe('resolveWeights', () => {
  it('falls back to neutral defaults when null', () => {
    expect(resolveWeights(null)).toBe(DEFAULT_DRIVE_WEIGHTS);
    expect(resolveWeights(undefined)).toBe(DEFAULT_DRIVE_WEIGHTS);
  });

  it('passes through learned weights', () => {
    const custom = { ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.9 };
    expect(resolveWeights(custom)).toBe(custom);
  });
});
