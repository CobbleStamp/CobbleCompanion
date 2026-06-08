/** Registry completeness/uniqueness + a version snapshot that locks prompt drift. */

import { describe, expect, it } from 'vitest';
import { getPromptEntry, listPrompts } from './registry.js';
import type { PromptId } from './types.js';

/** Every prompt id expected to be registered (kept in sync with the union). */
const ALL_IDS: readonly PromptId[] = [
  'persona',
  'affect-attunement',
  'persona-evolve',
  'consolidation',
  'ingestion-announce',
  'segmenter',
  'enricher',
  'affect-sense',
  'autonomous-note',
  'judge',
  'tool-search',
  'user-extract',
];

describe('prompt registry', () => {
  it('registers every PromptId exactly once', () => {
    const ids = listPrompts().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ALL_IDS].sort());
  });

  it('exposes each prompt by id', () => {
    for (const id of ALL_IDS) {
      expect(getPromptEntry(id)?.id).toBe(id);
    }
  });

  it('stamps a 16-hex content hash and a semver on every entry', () => {
    for (const entry of listPrompts()) {
      expect(entry.version.contentHash).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.version.semver).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('locks prompt versions against accidental drift', () => {
    const versions = Object.fromEntries(listPrompts().map((entry) => [entry.id, entry.version]));
    expect(versions).toMatchSnapshot();
  });
});
