/** Drive-weight EMA update — direction, clamping, immutability. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_DRIVE_WEIGHTS } from './drives.js';
import { updateDriveWeights, WEIGHT_CEILING, WEIGHT_FLOOR } from './weights.js';

describe('updateDriveWeights', () => {
  it('raises the served drive on positive reward, lowers on negative', () => {
    const up = updateDriveWeights(DEFAULT_DRIVE_WEIGHTS, 'curiosity', 1, 0.1);
    expect(up.curiosity).toBeCloseTo(0.6);
    const down = updateDriveWeights(DEFAULT_DRIVE_WEIGHTS, 'curiosity', -1, 0.1);
    expect(down.curiosity).toBeCloseTo(0.4);
  });

  it('only moves the served drive', () => {
    const next = updateDriveWeights(DEFAULT_DRIVE_WEIGHTS, 'curiosity', 1, 0.1);
    expect(next.bond).toBe(DEFAULT_DRIVE_WEIGHTS.bond);
    expect(next.approval).toBe(DEFAULT_DRIVE_WEIGHTS.approval);
  });

  it('clamps to the ceiling and the floor', () => {
    const high = updateDriveWeights({ ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.99 }, 'curiosity', 1, 1);
    expect(high.curiosity).toBe(WEIGHT_CEILING);
    const low = updateDriveWeights({ ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.06 }, 'curiosity', -1, 1);
    expect(low.curiosity).toBe(WEIGHT_FLOOR); // never dies to zero (exploration floor)
  });

  it('does not mutate the input', () => {
    const input = { ...DEFAULT_DRIVE_WEIGHTS };
    updateDriveWeights(input, 'curiosity', 1, 0.1);
    expect(input.curiosity).toBe(DEFAULT_DRIVE_WEIGHTS.curiosity);
  });

  it('converges upward under repeated positive reward', () => {
    let w = DEFAULT_DRIVE_WEIGHTS;
    for (let i = 0; i < 50; i += 1) w = updateDriveWeights(w, 'curiosity', 1);
    expect(w.curiosity).toBe(WEIGHT_CEILING);
  });
});
