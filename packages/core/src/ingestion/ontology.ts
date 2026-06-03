/**
 * The closed set of core fact types — the fixed half of the ontology contract
 * (docs/ontology.md). Extraction validates against this set: facts with unknown
 * core types are dropped, never stored. Dynamic leaf subtypes live as data in
 * the database, governed by the rules in docs/ontology.md, not enumerated here.
 */

export const CORE_FACT_TYPES = ['entity', 'attribute', 'relation', 'event', 'definition'] as const;

export type CoreFactType = (typeof CORE_FACT_TYPES)[number];

/** Type guard for the closed core fact-type set. */
export function isCoreFactType(value: string): value is CoreFactType {
  return (CORE_FACT_TYPES as readonly string[]).includes(value);
}
