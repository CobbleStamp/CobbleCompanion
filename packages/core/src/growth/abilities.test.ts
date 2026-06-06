/** Abilities registry — observational unlocks from substrate, pure. */

import { describe, expect, it } from 'vitest';
import { ABILITIES, abilityChecklist, abilityLabel, computeUnlocked } from './abilities.js';
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

describe('computeUnlocked', () => {
  it('unlocks nothing for a fresh companion', () => {
    expect(computeUnlocked(EMPTY)).toEqual([]);
  });

  it('unlocks web research and memory recall from distinct tools used', () => {
    const unlocked = computeUnlocked(sub({ distinctToolNames: ['web_fetch', 'memory_search'] }));
    expect(unlocked).toContain('web_research');
    expect(unlocked).toContain('memory_recall');
  });

  it('unlocks reading_sources once any source exists', () => {
    expect(computeUnlocked(sub({ sourceCount: 1 }))).toContain('reading_sources');
  });

  it('unlocks self_directed_work after an autonomous burst', () => {
    expect(computeUnlocked(sub({ hasAutonomousWork: true }))).toContain('self_directed_work');
  });

  it('unlocks first_routine once a procedure is learned', () => {
    expect(computeUnlocked(sub({ procedureCount: 1 }))).toContain('first_routine');
  });

  it('unlocks multi_step_task at two or more tool calls', () => {
    expect(computeUnlocked(sub({ toolCallTotal: 1 }))).not.toContain('multi_step_task');
    expect(computeUnlocked(sub({ toolCallTotal: 2 }))).toContain('multi_step_task');
  });

  it('unlocks mood_attunement once mood has been sensed', () => {
    expect(computeUnlocked(sub({ hasMoodSense: true }))).toContain('mood_attunement');
  });

  it('preserves registry display order', () => {
    const unlocked = computeUnlocked(
      sub({ hasMoodSense: true, distinctToolNames: ['web_fetch'], sourceCount: 1 }),
    );
    // web_research precedes reading_sources precedes mood_attunement in the registry.
    expect(unlocked).toEqual(['web_research', 'reading_sources', 'mood_attunement']);
  });
});

describe('abilityChecklist', () => {
  it('returns every ability flagged by unlocked state', () => {
    const checklist = abilityChecklist(['web_research']);
    expect(checklist).toHaveLength(ABILITIES.length);
    expect(checklist.find((a) => a.key === 'web_research')?.unlocked).toBe(true);
    expect(checklist.find((a) => a.key === 'memory_recall')?.unlocked).toBe(false);
  });
});

describe('abilityLabel', () => {
  it('returns the human label for a known key', () => {
    expect(abilityLabel('web_research')).toBe('Web research');
  });
});
