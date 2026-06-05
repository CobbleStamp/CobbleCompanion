/** Arbitration gate — the decision table for whether/what to initiate (v1). */

import type { ProactivityDial } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import {
  type ArbitrationInput,
  DEFAULT_KNOBS,
  ESTIMATED_READ_COST_TOKENS,
  decideMove,
} from './arbitration.js';
import { DEFAULT_DRIVE_WEIGHTS, type DriveLevels } from './drives.js';
import type { PresenceState } from './presence.js';

const ZERO_LEVELS: DriveLevels = {
  curiosity: 0,
  bond: 0,
  understanding: 0,
  approval: 0,
  helpfulness: 0,
  upkeep: 0,
};

function input(overrides: Partial<ArbitrationInput> = {}): ArbitrationInput {
  return {
    levels: { ...ZERO_LEVELS, curiosity: 1 },
    weights: DEFAULT_DRIVE_WEIGHTS,
    presence: 'attentive' as PresenceState,
    dial: 'gentle' as ProactivityDial,
    // Plenty of energy for a full focus-length burst by default.
    energyRemaining: ESTIMATED_READ_COST_TOKENS * (DEFAULT_KNOBS.focusLength + 2),
    knobs: DEFAULT_KNOBS,
    ...overrides,
  };
}

describe('decideMove', () => {
  it('explores when curiosity pressure clears the gentle threshold', () => {
    const move = decideMove(input());
    expect(move?.kind).toBe('explore');
    expect(move?.drive).toBe('curiosity');
    expect(move?.limit).toBe(DEFAULT_KNOBS.focusLength);
  });

  it('idles when the dial is off', () => {
    expect(decideMove(input({ dial: 'off' }))).toBeNull();
  });

  it('idles when energy cannot afford even one read', () => {
    expect(decideMove(input({ energyRemaining: 0 }))).toBeNull();
    expect(decideMove(input({ energyRemaining: ESTIMATED_READ_COST_TOKENS - 1 }))).toBeNull();
  });

  it('caps the burst to what remaining energy can afford (self-regulation)', () => {
    // Only enough energy for 2 reads, though focus length is 3.
    const move = decideMove(input({ energyRemaining: ESTIMATED_READ_COST_TOKENS * 2 }));
    expect(move?.limit).toBe(2);
  });

  it('idles while the user is active (do not self-initiate)', () => {
    expect(decideMove(input({ presence: 'active' }))).toBeNull();
  });

  it('idles when curiosity pressure is below the threshold', () => {
    // 0.2 level × 0.5 neutral weight = 0.1 < gentle 0.3
    expect(decideMove(input({ levels: { ...ZERO_LEVELS, curiosity: 0.2 } }))).toBeNull();
  });

  it('active dial initiates at a pressure gentle would reject', () => {
    const levels: DriveLevels = { ...ZERO_LEVELS, curiosity: 0.4 }; // 0.4×0.5 = 0.2
    expect(decideMove(input({ levels, dial: 'gentle' }))).toBeNull(); // 0.2 < 0.3
    expect(decideMove(input({ levels, dial: 'active' }))?.kind).toBe('explore'); // 0.2 > 0.15
  });

  it('does solo work while away', () => {
    expect(decideMove(input({ presence: 'away_short' }))?.kind).toBe('explore');
    expect(decideMove(input({ presence: 'absent_long' }))?.kind).toBe('explore');
  });

  it('a higher learned curiosity weight lowers the bar to act', () => {
    const levels: DriveLevels = { ...ZERO_LEVELS, curiosity: 0.4 };
    const weights = { ...DEFAULT_DRIVE_WEIGHTS, curiosity: 0.9 }; // 0.4×0.9 = 0.36 > 0.3
    expect(decideMove(input({ levels, weights, dial: 'gentle' }))?.kind).toBe('explore');
  });
});
