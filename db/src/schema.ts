import type { IngestionStatus, MessageRole, SourceKind } from '@cobble/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Data model (implementation.md §1). Multi-tenant: every row is reachable
 * only through its owning user/companion (architecture.md invariant #5).
 * Phase 0: users/companions/messages. Phase 1 adds the semantic-memory tables
 * (sources/sections/facts/ingestion_jobs — original text canonical, the fact
 * overlay indexes INTO it; see docs/ontology.md).
 *
 * Auth is handled by Google Sign-In; users are JIT-provisioned by the email
 * claim on a verified Google ID token, so there is no local credential/token table.
 */

/**
 * Embedding dimensionality pinned for the `sections.embedding` vector column.
 * The embedding gateway must request exactly this many dimensions; changing it
 * requires a new migration (implementation.md §3).
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** Postgres `tsvector` column type for full-text search (not built into drizzle). */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The companion "home" — the canonical identity a surface loads from (invariant #4). */
export const companions = pgTable(
  'companions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    form: text('form').notNull(),
    // The immutable creation seed. Personality EVOLUTION is additive (below): the
    // seed is never overwritten so the companion's origin stays legible.
    temperament: text('temperament').notNull(),
    // Phase 2 — personality evolution. The re-synthesized "who I've become with
    // you", blended into the persona prompt alongside the seed; null until the
    // first evolution pass runs. `persona_updated_through_seq` is the transcript
    // point it was last synthesized from, so evolution is incremental and
    // restart-safe (mirrors the ingestion deferral cursor pattern).
    evolvedPersona: text('evolved_persona'),
    personaUpdatedThroughSeq: bigint('persona_updated_through_seq', { mode: 'number' })
      .notNull()
      .default(0),
    // Phase 2 — episodic consolidation cursor: the highest transcript `seq` already
    // rolled into episodes. The background consolidation pass resumes from here, so
    // only new transcript is processed and re-runs are idempotent by seq range.
    consolidatedThroughSeq: bigint('consolidated_through_seq', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('companions_owner_idx').on(table.ownerId)],
);

/**
 * Transcript — the episodic-memory substrate (implementation.md §1). A companion
 * has exactly ONE continuous, lifelong conversation with its user, so messages
 * attach directly to the companion (architecture.md invariant: no conversation/
 * session entity). The whole conversation is `messages WHERE companion_id = ?
 * ORDER BY seq`.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Monotonic per-row ordinal — the authoritative chronological order, since
    // many turns can share a created_at timestamp at sub-millisecond resolution.
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull(),
    // Optional link to the source a turn is about — set on the attachment chip
    // and acknowledgement an upload writes, so they reconstruct on reload. Null
    // for ordinary typed turns. `set null` keeps the append-only transcript turn
    // even if the source is later deleted.
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('messages_companion_idx').on(table.companionId, table.seq)],
);

/**
 * Episodic memory (Phase 2) — consolidated, time-anchored memories DERIVED from
 * the transcript, not a parallel conversation. A background reflection pass rolls
 * spans of `messages` into consolidated `summary` narratives ("last July in
 * Lima you loved that ceviche"), embedded + FTS-indexed so the harness can recall
 * the right past episode by topic. The transcript stays canonical: episodes
 * are rebuildable from it and never substitute for it (no session entity — the one
 * lifelong conversation is preserved, invariant #6).
 *
 * `seq_start`/`seq_end` record the transcript range consolidated, so the pass is
 * incremental (resumes past `companions.consolidated_through_seq`) and idempotent
 * (a range maps to a deterministic episode set). `occurred_*` are the wall-clock
 * span (the date shown on a recalled block); the store can filter recall to a time
 * window, but no recall path passes one yet, so production recall is topic-only.
 * Mirrors `sections` for the vector/FTS hybrid machinery.
 */
export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    // The consolidated narrative — what's worth remembering about this span.
    summary: text('summary').notNull(),
    // The transcript range this episode consolidated (idempotency + incrementality).
    seqStart: bigint('seq_start', { mode: 'number' }).notNull(),
    seqEnd: bigint('seq_end', { mode: 'number' }).notNull(),
    // Wall-clock span the episode covers — the date shown on a recalled block, and
    // the column the store's (currently unwired) time-window filter ranges over.
    occurredStart: timestamp('occurred_start', { withTimezone: true }).notNull(),
    occurredEnd: timestamp('occurred_end', { withTimezone: true }).notNull(),
    // Self-reported 0–1 weight: how much this episode matters. Stored and displayed
    // only — recall (RRF) does not use it; filler is dropped at consolidation time.
    salience: real('salience'),
    // Nullable until the embedding pass completes (mirrors sections.embedding).
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    fts: tsvector('fts').generatedAlwaysAs(sql`to_tsvector('english', summary)`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Time-window filter (store capability) and "latest episodes" scans.
    index('episodes_companion_time_idx').on(table.companionId, table.occurredEnd),
    // Cursor lookups + range-dedup on the consolidation path.
    index('episodes_companion_seq_idx').on(table.companionId, table.seqEnd),
    index('episodes_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('episodes_fts_idx').using('gin', table.fts),
  ],
);

/**
 * Layer 0 — sources: the verbatim originals the user fed the companion. The
 * extracted `raw_text` is the canonical knowledge substrate; everything derived
 * (sections, facts) is rebuildable from it and never substitutes for it.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SourceKind>().notNull(),
    title: text('title').notNull(),
    // Filename for uploaded files, URL for links, null for notes.
    origin: text('origin'),
    rawText: text('raw_text').notNull(),
    byteSize: integer('byte_size'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sources_companion_idx').on(table.companionId)],
);

/**
 * Off-request-path ingestion status — the durable progress surface behind the
 * "Cobble has read 3 of 5 books" UI. One job per source ingestion run.
 */
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    status: text('status').$type<IngestionStatus>().notNull().default('queued'),
    sectionsTotal: integer('sections_total').notNull().default(0),
    sectionsDone: integer('sections_done').notNull().default(0),
    // User-safe failure reason; internal detail stays in logs.
    error: text('error'),
    // Parsed paragraphs held while a job is `deferred` (over the daily token cap):
    // parsing is free, so we keep its output and resume the AI passes after reset
    // without re-uploading. Null outside the deferred state.
    parsedDoc: jsonb('parsed_doc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ingestion_jobs_companion_idx').on(table.companionId, table.status)],
);

/**
 * Layer 1 — sections: the retrieval units. `original_text` is a PURE VERBATIM
 * slice of the source (whole paragraphs, never split mid-paragraph); the
 * embedding may additionally be conditioned on `context_header`, but the stored
 * text is always the original so the companion can quote it and cite where to
 * read it (para/page ranges).
 */
export const sections = pgTable(
  'sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Denormalized tenancy scope for fast filtered retrieval.
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    chapterTitle: text('chapter_title'),
    // Pass-1 (segmentation) output: what this section is about.
    topicTitle: text('topic_title').notNull(),
    originalText: text('original_text').notNull(),
    // Pass-2 (enrichment) output: one-line context for embedding disambiguation.
    contextHeader: text('context_header'),
    paraStart: integer('para_start').notNull(),
    paraEnd: integer('para_end').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    // Section order within its source.
    ord: integer('ord').notNull(),
    // Nullable until the embedding pass completes.
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    // Generated in the migration as: GENERATED ALWAYS AS (to_tsvector('english', original_text)) STORED
    fts: tsvector('fts').generatedAlwaysAs(sql`to_tsvector('english', original_text)`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sections_companion_idx').on(table.companionId),
    index('sections_source_idx').on(table.sourceId, table.ord),
    index('sections_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('sections_fts_idx').using('gin', table.fts),
  ],
);

/**
 * Layer 2 — facts: the typed knowledge overlay (docs/ontology.md). An index INTO
 * the verbatim text: every fact carries `section_id` provenance and the overlay
 * is rebuildable from sources without data loss. Entities are denormalized
 * strings in subject/object (normalization is a deferred ontology evolution).
 */
export const facts = pgTable(
  'facts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    // Core fact type from the closed ontology set (validated at ingestion).
    factType: text('fact_type').notNull(),
    subject: text('subject').notNull(),
    predicate: text('predicate'),
    object: text('object').notNull(),
    // Pass-2 self-reported extraction confidence (0–1).
    confidence: real('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('facts_companion_idx').on(table.companionId, table.factType),
    index('facts_section_idx').on(table.sectionId),
  ],
);

/**
 * Per-user token budget for the daily cap (architecture.md token budget). One
 * row per user: a running token counter for the current window plus the instant
 * it resets (fixed daily, UTC). When `now()` passes `window_reset_at` the window
 * rolls, carrying clamped overage forward as debt. `cap_override` grants an
 * account a non-default allowance (null → the configured default).
 */
export const userTokenUsage = pgTable('user_token_usage', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  windowResetAt: timestamp('window_reset_at', { withTimezone: true }).notNull(),
  usedTokens: bigint('used_tokens', { mode: 'number' }).notNull().default(0),
  capOverride: integer('cap_override'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  users,
  companions,
  messages,
  episodes,
  sources,
  ingestionJobs,
  sections,
  facts,
  userTokenUsage,
};
