/** Capabilities registry — observational, read off the substrate, pure. */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  capabilityChecklist,
  capabilityLabel,
  computeObserved,
} from './capabilities.js';
import type { GrowthSubstrate } from './substrate.js';

const EMPTY: GrowthSubstrate = {
  sourceCount: 0,
  sectionCount: 0,
  episodeCount: 0,
  averageSalience: 0,
  initiationCount: 0,
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

describe('computeObserved', () => {
  it('observes nothing for a fresh companion', () => {
    expect(computeObserved(EMPTY)).toEqual([]);
  });

  it('observes web research and memory recall from distinct tools used', () => {
    const observed = computeObserved(sub({ distinctToolNames: ['web_fetch', 'memory_search'] }));
    expect(observed).toContain('web_research');
    expect(observed).toContain('memory_recall');
  });

  it('observes reading_sources once any source exists', () => {
    expect(computeObserved(sub({ sourceCount: 1 }))).toContain('reading_sources');
  });

  it('observes first_routine once a procedure is learned', () => {
    expect(computeObserved(sub({ procedureCount: 1 }))).toContain('first_routine');
  });

  it('observes multi_step_task at two or more tool calls', () => {
    expect(computeObserved(sub({ toolCallTotal: 1 }))).not.toContain('multi_step_task');
    expect(computeObserved(sub({ toolCallTotal: 2 }))).toContain('multi_step_task');
  });

  it('observes mood_attunement once mood has been sensed', () => {
    expect(computeObserved(sub({ hasMoodSense: true }))).toContain('mood_attunement');
  });

  it('preserves registry display order', () => {
    const observed = computeObserved(
      sub({ hasMoodSense: true, distinctToolNames: ['web_fetch'], sourceCount: 1 }),
    );
    // web_research precedes reading_sources precedes mood_attunement in the registry.
    expect(observed).toEqual(['web_research', 'reading_sources', 'mood_attunement']);
  });
});

describe('capabilityChecklist', () => {
  it('returns every capability flagged by observed state', () => {
    const checklist = capabilityChecklist(['web_research']);
    expect(checklist).toHaveLength(CAPABILITIES.length);
    expect(checklist.find((c) => c.key === 'web_research')?.observed).toBe(true);
    expect(checklist.find((c) => c.key === 'memory_recall')?.observed).toBe(false);
  });
});

describe('capabilityLabel', () => {
  it('returns the human label for a known key', () => {
    expect(capabilityLabel('web_research')).toBe('Web research');
  });
});
