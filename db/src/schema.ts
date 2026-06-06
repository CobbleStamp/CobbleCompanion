import type {
  AbilityKey,
  Drive,
  DriveWeights,
  IngestionStatus,
  LeadStatus,
  MessageKind,
  MessageMetadata,
  MessageRole,
  PersonalityKnobs,
  ProactivityDial,
  ProposalOrigin,
  ProposalStatus,
  SourceKind,
} from '@cobble/shared';
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
  uniqueIndex,
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
    // Phase 4 — proactivity. The user-facing intensity dial (off/gentle/active):
    // scales how readily the motivation engine initiates and how much energy it
    // spends; `off` never initiates (companion-motivation.md §5).
    proactivityDial: text('proactivity_dial').$type<ProactivityDial>().notNull().default('gentle'),
    // The "creature" burst constants (focus/boredom/distractibility). Default
    // constants in the PoC (null → defaults); personalized via onboarding later.
    personalityKnobs: jsonb('personality_knobs').$type<PersonalityKnobs>(),
    // Per-drive learned weights the reinforcement loop updates; starts NEUTRAL
    // (null → neutral defaults). A Cobble is raised into its personality
    // (companion-motivation.md §7).
    driveWeights: jsonb('drive_weights').$type<DriveWeights>(),
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
    // What this row IS, beyond who said it — so the rich conversation (grounded
    // answers, read-only tool steps, held proposals) reconstructs identically on
    // reload. `message` for ordinary turns; the LLM-context projection includes
    // only `message` rows (tool steps + proposals are UI chrome).
    kind: text('kind').$type<MessageKind>().notNull().default('message'),
    // Kind-specific extras (citations on a grounded answer, tool/proposal ids);
    // null for a plain turn. Lets the surface re-render the row faithfully.
    metadata: jsonb('metadata').$type<MessageMetadata>(),
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
/**
 * Approval queue (Phase 3, architecture.md §4.4). An effectful tool call the
 * companion wants to make is held here as `pending` until the user approves it;
 * `tool_args` is the serialized call. `status` advances pending→approved/rejected
 * exactly once via a conditional update (the propose→approve gate's atomic claim,
 * mirroring the deferred-job claim) so a double-confirm cannot double-execute.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    // The lead this proposal originated from (explore turns a reading-list lead
    // into a proposal), so resolving the proposal can advance the lead's
    // lifecycle: approve→'ingested', reject→'discarded'. Null for chat-origin
    // proposals that never came from a lead. `set null` on lead deletion keeps
    // the proposal's audit row but drops the dangling link.
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    // Where this proposal came from (architecture.md §4.4): `chat` re-enters the
    // loop on approval; `explore`/`autonomous` are self-directed, so the
    // motivation engine — not the confirm route — decides what's next. Default
    // `chat` keeps every pre-Phase-4 proposal behaving as before.
    origin: text('origin').$type<ProposalOrigin>().notNull().default('chat'),
    toolName: text('tool_name').notNull(),
    // The serialized tool-call arguments to run verbatim once approved.
    toolArgs: jsonb('tool_args').notNull(),
    // The provider's tool-call id, kept for audit/correlation; null if absent.
    toolCallId: text('tool_call_id'),
    // A short human description shown in the approval card.
    summary: text('summary').notNull(),
    status: text('status').$type<ProposalStatus>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('proposals_companion_status_idx').on(table.companionId, table.status)],
);

/**
 * Tool-call audit log (Phase 3 DoD: "every tool call is logged"). One row per
 * executed tool call — read-only and approved-effectful alike — capturing the
 * name, the args, and the result content. Append-only; never on the read path.
 */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Monotonic insertion order — `created_at` ties within a millisecond, so the
    // audit log orders by this for a deterministic newest-first listing.
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    args: jsonb('args').notNull(),
    result: text('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tool_calls_companion_idx').on(table.companionId, table.seq)],
);

/**
 * Lead inventory (Phase 3) — the companion's reading list: URLs discovered but
 * not yet read (e.g. links spotted while reading a page). The durable substrate
 * the Phase 4 motivation engine works through on idle; in Phase 3 it is worked on
 * the user's command. `(companion_id, url)` is unique so re-discovering a link is
 * idempotent. `seq` gives a stable order; `status` tracks new→read→ingested.
 */
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    // Why it was captured — the page/topic it came from. Null for user-added.
    why: text('why'),
    status: text('status').$type<LeadStatus>().notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('leads_companion_url_uniq').on(table.companionId, table.url),
    index('leads_companion_status_idx').on(table.companionId, table.status),
  ],
);

/**
 * Procedural memory (Phase 3 seed) — a learned, reusable workflow recorded after
 * a successful action (`steps` = the ordered tool names it ran). Browsable now;
 * retrieval-as-hint is deferred to the growth system (Phase 5).
 */
export const proceduralMemories = pgTable(
  'procedural_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    steps: jsonb('steps').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('procedural_companion_idx').on(table.companionId, table.seq)],
);

/**
 * Per-user STAMINA budget (the daily cap for user-initiated work). The effective
 * cap is `(cap_override ?? default) + top_up_tokens`: `cap_override` is a fixed
 * per-account ceiling, `top_up_tokens` is the user's manual feed grant (the simple
 * top-up control — the food/feeding economy is Phase 5) and persists across window
 * rolls. Keeping the grant in its own column (rather than folding it into
 * `cap_override`) means a later change to the configured default still reaches
 * fed users, and lets the top-up be an atomic SQL increment — mirrors
 * `companion_energy` exactly (the energy pool is the per-companion twin).
 */
export const userTokenUsage = pgTable('user_token_usage', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  windowResetAt: timestamp('window_reset_at', { withTimezone: true }).notNull(),
  usedTokens: bigint('used_tokens', { mode: 'number' }).notNull().default(0),
  capOverride: integer('cap_override'),
  topUpTokens: bigint('top_up_tokens', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-companion ENERGY budget (Phase 4, architecture.md §4.8) — the self-initiated
 * pool that fuels the motivation engine. Mirrors `user_token_usage` (the stamina
 * pool) but keyed per COMPANION, so autonomous work can never starve interaction.
 * The effective cap is `(cap_override ?? default) + top_up_tokens`; `top_up_tokens`
 * is the user's manual feed grant (the simple top-up control — the food/feeding
 * economy is Phase 5) and persists across window rolls. The daily window rolls
 * like stamina, carrying overage forward as debt clamped to one cap.
 */
export const companionEnergy = pgTable('companion_energy', {
  companionId: uuid('companion_id')
    .primaryKey()
    .references(() => companions.id, { onDelete: 'cascade' }),
  windowResetAt: timestamp('window_reset_at', { withTimezone: true }).notNull(),
  usedTokens: bigint('used_tokens', { mode: 'number' }).notNull().default(0),
  capOverride: integer('cap_override'),
  topUpTokens: bigint('top_up_tokens', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Affect — the companion's rolling read of the user's mood (Phase 4.2,
 * companion-motivation.md §7). One row per companion, upserted on every successful
 * affect read inside the agent loop (a non-read keeps the prior baseline and
 * writes nothing): `valence` ∈ [−1, 1] (how positive the user reads) plus a
 * short natural-language `note`. The harness feeds the *prior* read forward to
 * attune the next reply (fast loop), and the *change* in valence its own acts
 * produce is the reinforcement signal (slow loop). Durable so the next turn — even
 * after a restart, hours later — can compute the change from a real baseline.
 */
export const companionAffect = pgTable('companion_affect', {
  companionId: uuid('companion_id')
    .primaryKey()
    .references(() => companions.id, { onDelete: 'cascade' }),
  valence: real('valence').notNull(),
  note: text('note').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Reinforcement record (Phase 4, companion-motivation.md §7) — one row per
 * proactive initiation. The motivation engine writes it when it acts (linking the
 * report note it posted — `note_message_id` — and the drive it served, with a
 * snapshot of the weights at the time for attribution). When the user reacts to
 * the note, `reward` is filled in: the *change* in their mood across that reaction
 * (`delta = valence_now − valence_before`, Phase 4.2, sensed in the agent loop),
 * applied as an additive nudge to the served drive's weight — not approve/reject,
 * not the 4.1 absolute-valence critic. Doubles as the helpful-vs-annoying
 * measurement surface. (`proposal_id` is retained nullable for legacy rows.)
 */
export const proactiveOutcomes = pgTable(
  'proactive_outcomes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companionId: uuid('companion_id')
      .notNull()
      .references(() => companions.id, { onDelete: 'cascade' }),
    // The report note the user reacts to (Phase 4.1): the autonomous burst posts
    // one in-character "what I read" turn, and the user's reaction to it is the
    // reward signal. `set null` keeps the outcome for measurement if the message
    // is ever removed.
    noteMessageId: uuid('note_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    // Legacy (pre-4.1): the proposal this initiation produced, when autonomous
    // work surfaced as an approval card. Retained nullable for old rows; the
    // current model surfaces a note (above), not a proposal.
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    // The drive the move served (whose weight the reward nudges).
    drive: text('drive').$type<Drive>().notNull(),
    // The companion's drive weights at initiation (attribution/debug).
    driveSnapshot: jsonb('drive_snapshot').$type<DriveWeights>(),
    // The blended reward once the user reacted; null until resolved.
    reward: real('reward'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('proactive_outcomes_companion_idx').on(table.companionId, table.seq),
    index('proactive_outcomes_proposal_idx').on(table.proposalId),
  ],
);

/**
 * Growth snapshot (Phase 5, development-plan.md §3) — the companion's bond/growth
 * standing, made visible and felt. Growth itself is DERIVED from substrate that
 * already exists (sources/sections/episodes counts, learned drive weights, tool &
 * procedure logs); this row is NOT a parallel score. It is the *acknowledged
 * high-water mark* — the last levels/abilities/stage the progression pass already
 * celebrated — so transitions (a level-up, a new ability) fire EXACTLY ONCE and
 * the treats they award are not double-granted on a re-run. This mirrors the P2
 * `consolidated_through_seq` cursor: derived truth recomputes freely, the cursor
 * makes the side effects idempotent.
 *
 * `treats` is the earned currency (the only stored, non-derived value): granted on
 * growth milestones, spent on food in the feeding economy (an atomic SQL
 * increment/decrement, mirroring the energy top-up). One row per companion,
 * created lazily on first recompute.
 */
export const companionGrowth = pgTable('companion_growth', {
  companionId: uuid('companion_id')
    .primaryKey()
    .references(() => companions.id, { onDelete: 'cascade' }),
  // Smooth axes — last celebrated level (the high-water mark for level-up events).
  knowledgeLevel: integer('knowledge_level').notNull().default(0),
  relationshipLevel: integer('relationship_level').notNull().default(0),
  // Discrete axis — the set of capability unlocks already acknowledged.
  unlockedAbilities: jsonb('unlocked_abilities')
    .$type<readonly AbilityKey[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // Blended headline stage (drives the emoji/badge); last celebrated value.
  overallStage: integer('overall_stage').notNull().default(0),
  // The earned feeding currency — the one stored, non-derived value.
  treats: integer('treats').notNull().default(0),
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
  proposals,
  toolCalls,
  leads,
  proceduralMemories,
  userTokenUsage,
  companionEnergy,
  companionAffect,
  proactiveOutcomes,
  companionGrowth,
};
