/**
 * The prompt registry (docs/guide-prompts.md): the enumerable set of all
 * versioned prompts. Call sites import their concrete template directly; the
 * registry exists for enumeration — version reporting, completeness/uniqueness
 * tests, and the eval A/B axis (Phase B). Adding a prompt = adding it here.
 */

import { affectAttunementTemplate } from './catalog/affect-attunement.js';
import { affectSenseTemplate } from './catalog/affect-sense.js';
import { autonomousNoteTemplate } from './catalog/autonomous-note.js';
import { consolidationTemplate } from './catalog/consolidation.js';
import { enricherTemplate } from './catalog/enricher.js';
import { ingestionAnnounceTemplate } from './catalog/ingestion-announce.js';
import { judgeTemplate } from './catalog/judge.js';
import { personaEvolveTemplate } from './catalog/persona-evolve.js';
import { personaTemplate } from './catalog/persona.js';
import { segmenterTemplate } from './catalog/segmenter.js';
import { toolSearchTemplate } from './catalog/tool-search.js';
import { versionOf } from './render.js';
import type { PromptId, PromptTemplate, PromptVersion } from './types.js';

/** Type-erased metadata for one registered prompt (no generic build exposed). */
export interface PromptEntry {
  readonly id: PromptId;
  readonly semver: string;
  readonly description: string;
  readonly version: PromptVersion;
}

/** Project a concrete template to its registry entry (resolves its version). */
function toEntry<I>(template: PromptTemplate<I>): PromptEntry {
  return {
    id: template.id,
    semver: template.semver,
    description: template.description,
    version: versionOf(template),
  };
}

const ENTRIES: readonly PromptEntry[] = [
  toEntry(personaTemplate),
  toEntry(affectAttunementTemplate),
  toEntry(personaEvolveTemplate),
  toEntry(consolidationTemplate),
  toEntry(ingestionAnnounceTemplate),
  toEntry(segmenterTemplate),
  toEntry(enricherTemplate),
  toEntry(affectSenseTemplate),
  toEntry(autonomousNoteTemplate),
  toEntry(judgeTemplate),
  toEntry(toolSearchTemplate),
];

const REGISTRY: ReadonlyMap<PromptId, PromptEntry> = new Map(
  ENTRIES.map((entry) => [entry.id, entry]),
);

/** All registered prompt entries, in catalog order. */
export function listPrompts(): readonly PromptEntry[] {
  return ENTRIES;
}

/** The registry entry for a prompt id, or undefined if unregistered. */
export function getPromptEntry(id: PromptId): PromptEntry | undefined {
  return REGISTRY.get(id);
}
