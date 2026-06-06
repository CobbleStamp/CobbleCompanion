/** Growth level curves + personality spread — pure, deterministic. */

import type { DriveWeights } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GROWTH_CONFIG as cfg } from './config.js';
import {
  computeKnowledgeLevel,
  computeOverallStage,
  computeRelationshipLevel,
  knowledgePoints,
  personalitySpread,
  relationshipPoints,
  stageEmoji,
} from './levels.js';
import type { GrowthSubstrate } from './substrate.js';

const EMPTY: GrowthSubstrate = {
  sourceCount: 0,
  sectionCount: 0,
  episodeCount: 0,
  averageSalience: 0,
  procedureCount: 0,
  distinctToolNames: [],
  toolCallTotal: 0,
  hasAutonomousWork: false,
  hasMoodSense: false,
  driveWeights: null,
  evolvedPersona: null,
};

function sub(overrides: Partial<GrowthSubstrate>): GrowthSubstrate {
  return { ...EMPTY, ...overrides };
}

describe('knowledge axis', () => {
  it('is level 0 with no substrate', () => {
    expect(computeKnowledgeLevel(EMPTY, cfg)).toEqual({ level: 0, progress: 0 });
  });

  it('weights sources, sections, and episodes into points', () => {
    // 1 source (3) + 7 sections (7) + 0 episodes = 10 points = exactly one level.
    expect(knowledgePoints(sub({ sourceCount: 1, sectionCount: 7 }), cfg)).toBe(10);
    expect(computeKnowledgeLevel(sub({ sourceCount: 1, sectionCount: 7 }), cfg)).toEqual({
      level: 1,
      progress: 0,
    });
  });

  it('reports fractional progress toward the next level', () => {
    // 15 points → level 1, halfway to level 2 (per-level = 10).
    const level = computeKnowledgeLevel(sub({ sourceCount: 5 }), cfg);
    expect(level.level).toBe(1);
    expect(level.progress).toBeCloseTo(0.5);
  });

  it('clamps at the max axis level with full progress', () => {
    const huge = computeKnowledgeLevel(sub({ sectionCount: 100_000 }), cfg);
    expect(huge.level).toBe(cfg.maxAxisLevel);
    expect(huge.progress).toBe(1);
  });
});

describe('relationship axis', () => {
  it('grows with episodes and average salience', () => {
    // 4 episodes (×2 = 8) + 0.8 salience (×10 = 8) = 16 points = level 2 (per-level 8).
    expect(relationshipPoints(sub({ episodeCount: 4, averageSalience: 0.8 }), cfg)).toBe(16);
    expect(
      computeRelationshipLevel(sub({ episodeCount: 4, averageSalience: 0.8 }), cfg).level,
    ).toBe(2);
  });
});

describe('overall stage', () => {
  it('blends both axis levels and the unlock count', () => {
    // (2 + 1 + 3) = 6 points / 3 per stage = stage 2.
    expect(computeOverallStage(2, 1, 3, cfg)).toBe(2);
  });

  it('clamps to the emoji ladder', () => {
    const stage = computeOverallStage(50, 50, 7, cfg);
    expect(stage).toBe(cfg.stageEmoji.length - 1);
    expect(stageEmoji(stage, cfg)).toBe(cfg.stageEmoji[cfg.stageEmoji.length - 1]);
  });

  it('maps stage 0 to the first emoji', () => {
    expect(stageEmoji(0, cfg)).toBe(cfg.stageEmoji[0]);
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
