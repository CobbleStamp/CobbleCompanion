/** Drive-weight change-as-reward update — direction, clamping, immutability. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_DRIVE_WEIGHTS } from './drives.js';
import { nudgeDriveWeight, WEIGHT_CEILING, WEIGHT_FLOOR } from './weights.js';

describe('nudgeDriveWeight (change-as-reward)', () => {
  it('raises on positive delta, lowers on negative — additive, not toward a target', () => {
    // 0.5 + 0.1·(+0.8) = 0.58; 0.5 + 0.1·(−0.8) = 0.42.
    expect(nudgeDriveWeight(DEFAULT_DRIVE_WEIGHTS, 'curiosity', 0.8, 0.1).curiosity).toBeCloseTo(
      0.58,
    );
    expect(nudgeDriveWeight(DEFAULT_DRIVE_WEIGHTS, 'curiosity', -0.8, 0.1).curiosity).toBeCloseTo(
      0.42,
    );
  });

  it('is an EXACT no-op on a zero delta (a neutral reaction leaves personality alone)', () => {
    const before = { ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.73 };
    const after = nudgeDriveWeight(before, 'curiosity', 0, 0.1);
    expect(after.curiosity).toBe(0.73); // not nudged toward zero (the EMA's flaw)
    expect(after).toEqual(before);
  });

  it('only moves the served drive', () => {
    const next = nudgeDriveWeight(DEFAULT_DRIVE_WEIGHTS, 'curiosity', 1, 0.1);
    expect(next.bond).toBe(DEFAULT_DRIVE_WEIGHTS.bond);
  });

  it('clamps to the ceiling and the floor', () => {
    expect(
      nudgeDriveWeight({ ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.99 }, 'curiosity', 1, 1).curiosity,
    ).toBe(WEIGHT_CEILING);
    expect(
      nudgeDriveWeight({ ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.06 }, 'curiosity', -1, 1).curiosity,
    ).toBe(WEIGHT_FLOOR);
  });

  it('does not mutate the input', () => {
    const input = { ...DEFAULT_DRIVE_WEIGHTS };
    nudgeDriveWeight(input, 'curiosity', 1, 0.1);
    expect(input.curiosity).toBe(DEFAULT_DRIVE_WEIGHTS.curiosity);
  });

  it('is a no-op on a non-finite delta (clamp cannot tame NaN; one NaN weight kills a drive)', () => {
    const before = { ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.5 };
    for (const bad of [NaN, Infinity, -Infinity]) {
      const after = nudgeDriveWeight(before, 'curiosity', bad, 0.1);
      expect(Number.isFinite(after.curiosity)).toBe(true);
      expect(after.curiosity).toBe(0.5); // weight untouched, never NaN
      expect(after).toEqual(before);
    }
  });
});
