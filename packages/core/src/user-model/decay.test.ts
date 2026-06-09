import { describe, expect, it } from 'vitest';
import {
  BELIEF_SALIENCE_HALF_LIFE_DAYS,
  effectiveSalience,
  isStale,
  STALE_SALIENCE_FLOOR,
} from './decay.js';

const DAY_MS = 86_400_000;

describe('effectiveSalience (lazy belief decay, Phase 13)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('returns the stored value when freshly touched (no decay)', () => {
    expect(effectiveSalience(0.8, now, now)).toBe(0.8);
  });

  it('treats a future updatedAt as no decay (clamped)', () => {
    const future = new Date(now.getTime() + DAY_MS);
    expect(effectiveSalience(0.8, future, now)).toBe(0.8);
  });

  it('halves after one half-life', () => {
    const oneHalfLifeAgo = new Date(now.getTime() - BELIEF_SALIENCE_HALF_LIFE_DAYS * DAY_MS);
    expect(effectiveSalience(0.8, oneHalfLifeAgo, now)).toBeCloseTo(0.4, 5);
  });

  it('quarters after two half-lives', () => {
    const twoHalfLivesAgo = new Date(now.getTime() - 2 * BELIEF_SALIENCE_HALF_LIFE_DAYS * DAY_MS);
    expect(effectiveSalience(0.8, twoHalfLivesAgo, now)).toBeCloseTo(0.2, 5);
  });

  it('reads a null salience as zero', () => {
    expect(effectiveSalience(null, new Date(now.getTime() - DAY_MS), now)).toBe(0);
  });

  it('flags decayed-below-floor as stale, fresh as live', () => {
    const longAgo = new Date(now.getTime() - 10 * BELIEF_SALIENCE_HALF_LIFE_DAYS * DAY_MS);
    expect(isStale(effectiveSalience(0.5, longAgo, now))).toBe(true);
    expect(isStale(effectiveSalience(0.5, now, now))).toBe(false);
    expect(isStale(STALE_SALIENCE_FLOOR - 0.001)).toBe(true);
    expect(isStale(STALE_SALIENCE_FLOOR)).toBe(false);
  });
});
