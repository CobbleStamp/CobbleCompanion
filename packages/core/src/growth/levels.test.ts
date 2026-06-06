/** Growth axis readings (band + fill) + personality spread — pure, deterministic. */

import type { DriveWeights } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GROWTH_CONFIG as cfg } from './config.js';
import {
  bondPoints,
  computeBondReading,
  computeCharacterReading,
  computeInitiativeReading,
  computeKnowledgeReading,
  knowledgePoints,
  personalitySpread,
} from './levels.js';
import type { GrowthSubstrate } from './substrate.js';

const EMPTY: GrowthSubstrate = {
  sourceCount: 0,
  sectionCount: 0,
  episodeCount: 0,
  averageSalience: 0,
  initiationCount: 0,
  resolvedReactionCount: 0,
  positiveReactionCount: 0,
  procedureCount: 0,
  distinctToolNames: [],
  toolCallTotal: 0,
  hasMoodSense: false,
  driveWeights: null,
  evolvedPersona: null,
};

function sub(overrides: Partial<GrowthSubstrate>): GrowthSubstrate {
  return { ...EMPTY, ...overrides };
}

describe('knowledge axis', () => {
  it('reads the empty band with no substrate', () => {
    expect(computeKnowledgeReading(EMPTY, cfg)).toEqual({ index: 0, band: 'Sparse', fill: 0 });
  });

  it('weights sources, sections, and episodes into points', () => {
    // 1 source (3) + 7 sections (7) + 0 episodes = 10 points = exactly one band step.
    expect(knowledgePoints(sub({ sourceCount: 1, sectionCount: 7 }), cfg)).toBe(10);
    expect(computeKnowledgeReading(sub({ sourceCount: 1, sectionCount: 7 }), cfg)).toEqual({
      index: 1,
      band: 'Growing',
      fill: 0,
    });
  });

  it('reports fractional fill within the current band', () => {
    // 15 points → band 1 (Growing), halfway through the 10-wide band.
    const reading = computeKnowledgeReading(sub({ sourceCount: 5 }), cfg);
    expect(reading.index).toBe(1);
    expect(reading.fill).toBeCloseTo(0.5);
  });

  it('clamps at the top band with a full gauge', () => {
    const huge = computeKnowledgeReading(sub({ sectionCount: 100_000 }), cfg);
    expect(huge.index).toBe(cfg.knowledgeBands.length - 1);
    expect(huge.band).toBe('Vast');
    expect(huge.fill).toBe(1);
  });
});

describe('bond axis', () => {
  it('grows with episodes and average salience', () => {
    // 4 episodes (×2 = 8) + 0.8 salience (×10 = 8) = 16 points → band 2 (width 8).
    expect(bondPoints(sub({ episodeCount: 4, averageSalience: 0.8 }), cfg)).toBe(16);
    const reading = computeBondReading(sub({ episodeCount: 4, averageSalience: 0.8 }), cfg);
    expect(reading.index).toBe(2);
    expect(reading.band).toBe('Familiar');
  });

  it('reads the empty band with no shared history', () => {
    expect(computeBondReading(EMPTY, cfg)).toEqual({ index: 0, band: 'New', fill: 0 });
  });
});

describe('initiative axis', () => {
  it('reads the honest empty band before any self-directed act', () => {
    const reading = computeInitiativeReading(EMPTY, cfg);
    expect(reading.index).toBe(0);
    expect(reading.band).toBe("Hasn't ventured out yet");
  });

  it('climbs the bands as initiations accumulate', () => {
    expect(computeInitiativeReading(sub({ initiationCount: 1 }), cfg).band).toBe('Tentative');
    expect(computeInitiativeReading(sub({ initiationCount: 4 }), cfg).band).toBe('Active');
    expect(computeInitiativeReading(sub({ initiationCount: 20 }), cfg).band).toBe('Self-directed');
  });
});

describe('character axis', () => {
  it('reads "Still forming" for a never-reinforced companion', () => {
    expect(computeCharacterReading(null, cfg)).toEqual({
      index: 0,
      band: 'Still forming',
      fill: 0,
    });
  });

  it('reads a higher band as the disposition diverges from neutral', () => {
    const extreme: DriveWeights = {
      curiosity: 1,
      bond: 0,
      understanding: 1,
      approval: 0,
      helpfulness: 1,
      upkeep: 0,
    };
    expect(computeCharacterReading(extreme, cfg).band).toBe('Strongly formed');
  });
});

describe('personality spread', () => {
  it('reads 0 for null (never-reinforced) weights', () => {
    expect(personalitySpread(null)).toBe(0);
  });

  it('reads 0 for fully neutral weights', () => {
    const neutral: DriveWeights = {
      curiosity: 0.5,
      bond: 0.5,
      understanding: 0.5,
      approval: 0.5,
      helpfulness: 0.5,
      upkeep: 0.5,
    };
    expect(personalitySpread(neutral)).toBe(0);
  });

  it('reads 1 when every drive is at an extreme', () => {
    const extreme: DriveWeights = {
      curiosity: 1,
      bond: 0,
      understanding: 1,
      approval: 0,
      helpfulness: 1,
      upkeep: 0,
    };
    expect(personalitySpread(extreme)).toBeCloseTo(1);
  });

  it('reads between 0 and 1 for a partly-formed character', () => {
    const partial: DriveWeights = {
      curiosity: 0.9,
      bond: 0.7,
      understanding: 0.5,
      approval: 0.5,
      helpfulness: 0.5,
      upkeep: 0.5,
    };
    const spread = personalitySpread(partial);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(1);
  });
});
