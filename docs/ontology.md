# CobbleCompanion — Ontology Contract & Governance

> **What it is:** the contract governing the companion's structured knowledge — the **fixed core
> types** the system depends on, and the **rules for the dynamic part** that grows as data. Per
> the documentation ownership rules (`AGENTS.md`), this doc owns the contract and its governance
> only; the catalog of leaf types that emerges over time is **data in the database**, never
> enumerated here. Data model/schema → `implementation.md` §1; memory mechanics →
> `companionmemory.md`.

## 1. Purpose & Position

Phase 1 gives the companion a **knowledge overlay**: typed facts extracted from the sources it
reads (`facts` table, `implementation.md` §1). The overlay is what makes semantic memory
*organized knowledge* rather than a search index — it powers entity-based metadata retrieval and
cross-source connection.

Its position in the architecture is fixed by two invariants:

1. **The original text is canonical.** The overlay is an index *into* verbatim source text,
   never a substitute for it. Every fact carries a `section_id` pointing at the verbatim passage
   that supports it.
2. **The overlay is rebuildable.** Deleting and re-extracting all facts from `sources.raw_text`
   must lose nothing canonical. A wrong fact is a quality bug, not data corruption.

## 2. The Fixed Core (closed set)

Every fact has a `fact_type` drawn from a **closed set of core types**. Extraction validates
against this set (`packages/core/src/ingestion/ontology.ts`); a fact with an unknown core type
is dropped and logged, never stored.

| Core type    | Captures                                  | Shape (subject · predicate · object) |
|--------------|-------------------------------------------|--------------------------------------|
| `entity`     | A thing that exists and matters            | entity · — · what it is              |
| `attribute`  | A property of an entity                    | entity · property · value            |
| `relation`   | A connection between two entities          | entity · relation · entity           |
| `event`      | Something that happened                    | actor · action · target/outcome      |
| `definition` | What a term means in this source's context | term · — · meaning                   |

Changing this set is a **contract change**: it requires updating the extraction validation, the
extraction prompt, this document, and consideration of facts already stored under the old set.
Do not add core types casually — most new needs are leaf types (§3).

## 3. The Dynamic Part (leaf types — rules, not a catalog)

Within a core type, extraction may qualify facts with finer-grained **leaf subtypes** (e.g. an
`entity` that is a *dish*, a *place*, a *person*). Rules:

- **Leaf types are data.** They live in fact rows (and future columns/tables), are queried from
  the database, and are never enumerated in documentation. This doc owns only the rules below.
- **Leaf types must refine, never escape, their core type.** A leaf is always a narrowing of
  exactly one of the five core types; anything that doesn't fit a core type is not storable.
- **Proposed bottom-up.** Pass 2 of ingestion (the enricher) may propose leaf qualifications
  from the text; they are accepted as data without contract changes.
- **Promotion is deliberate.** A leaf type only becomes load-bearing (i.e. code depends on it)
  through a contract change reviewed like a core-type change.

## 4. Provenance & Confidence Invariants

- **Every fact has provenance.** `facts.section_id` is non-nullable; a fact that cannot point at
  the verbatim passage supporting it must not be stored.
- **Confidence is advisory.** `facts.confidence` (0–1, extraction self-reported) ranks and
  filters; it never gates storage by itself.
- **Tenancy.** Facts are scoped by `companion_id` and cascade-delete with their companion,
  source, and section (`implementation.md` §1).

## 5. Governance & Evolution

- **Re-extraction is the upgrade path.** Improving the extraction prompt/model re-runs Pass 2
  over existing sections; the overlay is replaced, the canonical layers are untouched.
- **Quality is measured, not assumed.** The eval harness (`companionmemory.md` §5) is the gate
  for extraction changes — grounded recall and hallucination move measurably or the change is
  rejected.
- **Deferred (recorded decisions):**
  - **Entity normalization** — entities are currently denormalized strings in
    `facts.subject`/`facts.object`. A normalized entity table with resolution/dedup is a future,
    additive evolution (it changes retrieval quality, not the contract).
  - **Cross-source relations** — relations whose subject and object come from different sources
    (knowledge-graph linking) build on entity normalization.
