/**
 * The User-Model store (docs/companion-memory.md §4) — persistence for the companion's
 * typed knowledge about its USER. Owns the `user_facts` table: the Tier-1 core profile
 * (identity attributes carried in the persona every turn, Phase 11) and the Tier-2
 * learned-belief overlay (preferences/interests/opinions, hybrid-recalled, Phase 12).
 * Keyed by `user_id` (per-user; facts are objective truths shared across a user's
 * companions).
 *
 * `user_facts` is a CURRENT-STATE overlay (Phase 13): it holds what's true *now*; the
 * timeline of the self lives in episodic memory. A revision therefore **replaces** the
 * prior value rather than stacking a superseded chain — every row is current (ontology.md
 * §4). SINGULAR predicates keep one value for the `(user_id, predicate)`; MULTI-VALUED
 * predicates (`MULTI_VALUED_PREDICATES`: languages, relationships) accrete and replace only
 * an identical `(predicate, object)` restatement, so distinct values coexist.
 */
import {
  isMultiValuedPredicate,
  isTier2Predicate,
  TIER2_PREDICATES,
  type UserFactDto,
  type UserFactSource,
} from '@cobble/shared';
import { type Database, userFacts } from '@cobble/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { reciprocalRankFusion } from '../memory/rrf.js';
import { effectiveSalience, isStale } from './decay.js';
import { isSensitiveMatter } from './sensitive.js';

/** The privileged entity every user-fact is about (ontology.md §1). */
const USER_SUBJECT = 'user';
/** Identity attributes are `attribute` facts in the closed core set (ontology.md §2). */
const DEFAULT_IDENTITY_FACT_TYPE = 'attribute';
/** The singular `name` predicate, special-cased only for the sign-in seed guard. */
const NAME_PREDICATE = 'name';
/** A name from the Google profile is a guess about the account — modest confidence. */
const AUTH_SEED_CONFIDENCE = 0.5;
/** A value the user set directly is authoritative — it wins over any inference. */
const USER_EDIT_CONFIDENCE = 1;
/** A new Tier-2 belief starts mid-strength; reinforcement/decay move it from here. */
const DEFAULT_BELIEF_SALIENCE = 0.5;
/** Salience bump when an identical belief is restated (idempotent reinforcement). */
const BELIEF_REINFORCE_STEP = 0.1;
/**
 * How strongly `salience` tilts hybrid recall ranking (Phase 12). A belief's fused
 * relevance score is multiplied by `1 + WEIGHT * salience`, so salience ∈ [0, 1] maps
 * to a [1, 1 + WEIGHT]× boost. Kept gentle so relevance dominates — salience reorders
 * comparably-relevant hits and breaks near-ties (a reinforced belief rises, a cut one
 * sinks) rather than dragging in beliefs no arm found relevant. Tunable.
 */
const SALIENCE_RANK_WEIGHT = 0.5;
/** Beliefs are `attribute` facts in the closed core set (ontology.md §2). */
const BELIEF_FACT_TYPE = 'attribute';

/** Clamp a salience/confidence weight into the valid [0, 1] range. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** A Tier-1 identity attribute learned from a transcript turn. */
export interface RecordTranscriptFactInput {
  readonly userId: string;
  /** A Tier-1 identity attribute (`name`, `livesIn`, `languages`, …). Singular predicates
   *  keep one value; multi-valued ones accrete (`MULTI_VALUED_PREDICATES`). */
  readonly predicate: string;
  readonly object: string;
  /** The companion whose conversation taught this — the recorded provenance (the
   *  exact transcript `seq`, `user_facts.learned_from_seq`, stays NULL on this path:
   *  the inline capture reads `MessageDto`, which omits `seq`; pinning the turn is
   *  reserved for the Phase-12 reflector). */
  readonly learnedByCompanionId: string;
  /** Core fact type; defaults to `attribute` (identity). */
  readonly factType?: string;
  /** Extractor self-reported confidence (0–1). */
  readonly confidence?: number;
}

/**
 * A Tier-2 learned belief to persist (Phase 12) — written by inline capture (explicit
 * beliefs) and by the reflector (implicit beliefs + reconciliation). Carries the
 * embedding for hybrid recall; a null embedding still recalls via the generated `fts`.
 */
export interface RecordBeliefInput {
  readonly userId: string;
  /** A Tier-2 predicate (`prefers`/`dislikes`/`interestedIn`/`believes`). */
  readonly predicate: string;
  readonly object: string;
  /** Provenance origin; defaults to `transcript`. */
  readonly source?: UserFactSource;
  /** The companion whose conversation taught this (transcript provenance). */
  readonly learnedByCompanionId?: string;
  /** The transcript `seq` the belief was learned from — the reflector pins it; inline leaves null. */
  readonly learnedFromSeq?: number;
  /** Extractor self-reported confidence (0–1). */
  readonly confidence?: number;
  /** Initial strength weight; defaults mid-range. */
  readonly salience?: number;
  /** The belief embedding for hybrid recall; omit → FTS-only until back-filled. */
  readonly embedding?: readonly number[];
}

/** A current belief plus its fused hybrid-retrieval score (highest first). */
export interface BeliefHit {
  readonly belief: UserFactDto;
  readonly score: number;
}

/** Inputs to {@link UserModelStore.searchBeliefs} — the embedded + raw query turn. */
export interface BeliefSearchParams {
  /** The embedded query turn; empty (provider down) → FTS-only. */
  readonly queryEmbedding: readonly number[];
  readonly queryText: string;
  readonly topK: number;
  /**
   * Relevance floor for the vector arm: a maximum cosine distance (pgvector `<=>`,
   * range [0, 2]; 0 = identical, 1 = unrelated/orthogonal). When set, a belief whose
   * embedding is farther than this from the query is **not** returned — the arm recalls
   * "what's relevant", not "the K nearest regardless of relevance". Omitted → no floor
   * (the raw top-K, for callers that rank rather than gate, e.g. the salience tests).
   * The FTS arm self-gates (term match), so the floor applies only to the vector arm.
   */
  readonly maxVectorDistance?: number;
  /**
   * "Now", for the lazy salience decay (Phase 13). Injected so tests are deterministic;
   * production omits it and the store reads the wall clock. A belief whose salience has
   * decayed below the stale floor is dropped from recall (see `decay.ts`).
   */
  readonly now?: Date;
}

/**
 * Persistence boundary for the User Model. All reads/writes are scoped by `userId`
 * (tenancy); edit/delete additionally verify the fact belongs to the user.
 *
 * The "one row per `(userId, predicate)` for singular predicates" invariant is enforced
 * by the replace-within-transaction writes here PLUS the harness serializing captures
 * per-user (harness.ts `userFactChains`). For `name` specifically — seeded on every authed
 * request from auth-guard.ts, OUTSIDE that serialization — a partial unique index
 * (`user_facts_one_current_name_uniq`) also enforces it at the DB, so parallel first-load
 * seeds cannot double-insert; seedName absorbs the conflict. Other singular predicates rely
 * on serialization alone (sufficient for the single-instance PoC; the affect store makes the
 * same assumption). Multi-valued predicates hold several rows by design.
 */
export interface UserModelStore {
  /** Every current fact for the user, oldest-first. */
  listCurrent(userId: string): Promise<readonly UserFactDto[]>;
  /**
   * Record an identity attribute learned in conversation. A singular predicate replaces
   * the prior value for the same `(userId, predicate)`; a multi-valued one accretes,
   * replacing only an identical `(predicate, object)` restatement. Returns the new fact.
   */
  recordTranscriptFact(input: RecordTranscriptFactInput): Promise<UserFactDto>;
  /**
   * Seed the user's name from the sign-in provider — only if no `name` fact exists, so a
   * later sign-in can never resurrect the seed over a name the user has since stated or
   * edited. Returns the seeded fact, or null when a name already exists (no-op). Called
   * once, when the user is first created.
   */
  seedName(userId: string, name: string): Promise<UserFactDto | null>;
  /**
   * Apply a user edit to one of their facts: replace its value in place with an
   * authoritative `user_edit` value. Returns the updated fact, or null if the fact is not
   * found or not owned by the user.
   */
  editFact(userId: string, factId: string, object: string): Promise<UserFactDto | null>;
  /**
   * Forget a fact — delete the row outright (current-state overlay, no chain to keep).
   * Returns false if the fact is not a fact owned by the user.
   */
  forgetFact(userId: string, factId: string): Promise<boolean>;

  // --- Tier-2 learned beliefs (Phase 12) ---

  /** Every current Tier-2 belief for the user, most-recently-touched first. */
  listCurrentBeliefs(userId: string): Promise<readonly UserFactDto[]>;
  /**
   * Persist a Tier-2 belief. An identical current `(predicate, object)` belief is
   * **reinforced** (salience bumped, refreshed) rather than duplicated; otherwise a new
   * current belief is inserted. Returns the current belief row.
   */
  recordBelief(input: RecordBeliefInput): Promise<UserFactDto>;
  /** Hybrid (vector + FTS, RRF) recall over the user's current Tier-2 beliefs. */
  searchBeliefs(userId: string, params: BeliefSearchParams): Promise<readonly BeliefHit[]>;
  /**
   * The top-`k` current beliefs most similar to `embedding` (vector-only) — the bounded
   * reconciliation context the reflector judges a candidate against (`companion-memory.md` §4).
   */
  findSimilarBeliefs(
    userId: string,
    embedding: readonly number[],
    k: number,
  ): Promise<readonly UserFactDto[]>;
  /**
   * Adjust a current belief's salience by `delta` (clamped to [0, 1]); the reflector's
   * `reinforce` and the belief-learning reward (`companion-motivation.md` §7) both use it.
   * Returns the updated belief, or null if it isn't a current fact owned by the user.
   */
  adjustBeliefSalience(userId: string, factId: string, delta: number): Promise<UserFactDto | null>;
  /**
   * Replace a current belief with a newer-state value (the reflector's `replace` op —
   * current-state last-wins; the prior value is overwritten in place, the timeline staying
   * in episodic memory). Returns the updated belief, or null if it isn't a current fact
   * owned by the user.
   */
  replaceBelief(
    userId: string,
    oldFactId: string,
    replacement: RecordBeliefInput,
  ): Promise<UserFactDto | null>;
}

/** Drizzle/Postgres implementation of {@link UserModelStore}. */
export class DrizzleUserModelStore implements UserModelStore {
  constructor(private readonly db: Database) {}

  async listCurrent(userId: string): Promise<readonly UserFactDto[]> {
    const rows = await this.db
      .select()
      .from(userFacts)
      .where(eq(userFacts.userId, userId))
      .orderBy(userFacts.createdAt);
    return rows.map(toUserFactDto);
  }

  async recordTranscriptFact(input: RecordTranscriptFactInput): Promise<UserFactDto> {
    return this.db.transaction(async (tx) => {
      // Replace the prior value(s) for this predicate by DELETING them before inserting the
      // new row (current-state overlay — no superseded chain). A SINGULAR attribute (name,
      // age, …) keeps exactly one value, so every prior row for the predicate is removed. A
      // MULTI-VALUED attribute (languages, relationships) accretes, so only an identical
      // (predicate, object) restatement is removed — distinct values coexist. Delete-first
      // also keeps the `name` partial unique index satisfied (one `name` row per user).
      await tx
        .delete(userFacts)
        .where(
          and(
            eq(userFacts.userId, input.userId),
            eq(userFacts.predicate, input.predicate),
            isMultiValuedPredicate(input.predicate)
              ? eq(userFacts.object, input.object)
              : undefined,
          ),
        );
      const [created] = await tx
        .insert(userFacts)
        .values({
          userId: input.userId,
          source: 'transcript',
          learnedByCompanionId: input.learnedByCompanionId,
          factType: input.factType ?? DEFAULT_IDENTITY_FACT_TYPE,
          subject: USER_SUBJECT,
          predicate: input.predicate,
          object: input.object,
          confidence: input.confidence ?? null,
          sensitive: isSensitiveMatter(input.predicate, input.object),
        })
        .returning();
      if (!created) {
        throw new Error('failed to record user fact');
      }
      return toUserFactDto(created);
    });
  }

  async seedName(userId: string, name: string): Promise<UserFactDto | null> {
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }
    return this.db.transaction(async (tx) => {
      // Resurrection guard: any name fact means the user already has a name (seeded,
      // stated, or edited) — never seed over it.
      const [existing] = await tx
        .select({ id: userFacts.id })
        .from(userFacts)
        .where(and(eq(userFacts.userId, userId), eq(userFacts.predicate, NAME_PREDICATE)))
        .limit(1);
      if (existing) {
        return null;
      }
      const [created] = await tx
        .insert(userFacts)
        .values({
          userId,
          source: 'auth_seed',
          factType: DEFAULT_IDENTITY_FACT_TYPE,
          subject: USER_SUBJECT,
          predicate: NAME_PREDICATE,
          object: trimmed,
          confidence: AUTH_SEED_CONFIDENCE,
        })
        // Belt-and-suspenders with the read guard above: a concurrent seed (parallel
        // first-load requests, same user) can pass the guard too, but the
        // `user_facts_one_current_name_uniq` partial index makes the loser conflict
        // rather than double-insert. Swallow it — the winner's row is the seed, so a
        // lost race is a no-op, not an error.
        .onConflictDoNothing()
        .returning();
      // No row back means a concurrent seed won the race (conflict) — already seeded.
      return created ? toUserFactDto(created) : null;
    });
  }

  async editFact(userId: string, factId: string, object: string): Promise<UserFactDto | null> {
    const trimmed = object.trim();
    if (!trimmed) {
      return null;
    }
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(userFacts)
        .where(and(eq(userFacts.id, factId), eq(userFacts.userId, userId)))
        .limit(1);
      if (!target) {
        return null;
      }
      // Tier-1 only: editFact rewrites object but not salience/embedding, so it cannot
      // correctly revise a Tier-2 belief (the value would fall out of vector recall) — and
      // beliefs gain their own belief-aware edit path in Phase 13 Stage 4 (re-embed). Refuse
      // here, at the store chokepoint, so the invariant holds for every caller; routes
      // surface it as a 404.
      if (target.predicate !== null && isTier2Predicate(target.predicate)) {
        return null;
      }
      // Current-state overlay: replace the value IN PLACE (no chain to stack). The edit is
      // authoritative, so it raises confidence and stamps the `user_edit` origin.
      const [updated] = await tx
        .update(userFacts)
        .set({
          object: trimmed,
          source: 'user_edit',
          confidence: USER_EDIT_CONFIDENCE,
          sensitive: isSensitiveMatter(target.predicate, trimmed),
          updatedAt: new Date(),
        })
        .where(eq(userFacts.id, target.id))
        .returning();
      return updated ? toUserFactDto(updated) : null;
    });
  }

  async forgetFact(userId: string, factId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: userFacts.id, predicate: userFacts.predicate })
        .from(userFacts)
        .where(and(eq(userFacts.id, factId), eq(userFacts.userId, userId)))
        .limit(1);
      if (!target) {
        return false;
      }
      // Tier-1 only: beliefs gain edit/delete in Phase 13 Stage 4 (with a sensitive purge).
      // Refuse here, at the store chokepoint, so no caller can forget a learned belief; routes
      // surface it as a 404. (A SQL `NOT IN (tier2)` clause would mis-handle a null predicate,
      // so guard in code.)
      if (target.predicate !== null && isTier2Predicate(target.predicate)) {
        return false;
      }
      // Hard delete — the current-state overlay keeps no history (the timeline is episodic
      // memory's job, ontology.md §4).
      await tx.delete(userFacts).where(eq(userFacts.id, target.id));
      return true;
    });
  }

  // --- Tier-2 learned beliefs (Phase 12) ---

  /** The shared filter: a user's current Tier-2 belief rows. */
  private currentBeliefFilter(userId: string) {
    return and(eq(userFacts.userId, userId), inArray(userFacts.predicate, [...TIER2_PREDICATES]));
  }

  async listCurrentBeliefs(userId: string): Promise<readonly UserFactDto[]> {
    const rows = await this.db
      .select()
      .from(userFacts)
      .where(this.currentBeliefFilter(userId))
      .orderBy(desc(userFacts.updatedAt));
    return rows.map(toUserFactDto);
  }

  async recordBelief(input: RecordBeliefInput): Promise<UserFactDto> {
    return this.db.transaction(async (tx) => {
      // Idempotent restatement: an identical current (predicate, object) belief is
      // reinforced (salience bumped), never duplicated. Semantic dedup of *near*
      // restatements and contradiction are the reflector's job (companion-memory.md §4).
      const [existing] = await tx
        .select()
        .from(userFacts)
        .where(
          and(
            eq(userFacts.userId, input.userId),
            eq(userFacts.predicate, input.predicate),
            eq(userFacts.object, input.object),
          ),
        )
        .limit(1);
      if (existing) {
        const next = clamp01(
          (existing.salience ?? DEFAULT_BELIEF_SALIENCE) + BELIEF_REINFORCE_STEP,
        );
        const [bumped] = await tx
          .update(userFacts)
          .set({
            salience: next,
            updatedAt: new Date(),
            // Back-fill a missing embedding so a belief first stored FTS-only (embeddings
            // unconfigured, or an embed hiccup) joins the vector arm once an embedding is in
            // hand. Recall is vector-primary under the relevance floor, so without this an
            // FTS-only belief is permanently demoted. Fill only — never clobber a good vector.
            ...(existing.embedding == null && input.embedding
              ? { embedding: [...input.embedding] }
              : {}),
          })
          .where(eq(userFacts.id, existing.id))
          .returning();
        return toUserFactDto(bumped ?? existing);
      }
      const [created] = await tx
        .insert(userFacts)
        .values({
          userId: input.userId,
          source: input.source ?? 'transcript',
          learnedByCompanionId: input.learnedByCompanionId ?? null,
          learnedFromSeq: input.learnedFromSeq ?? null,
          factType: BELIEF_FACT_TYPE,
          subject: USER_SUBJECT,
          predicate: input.predicate,
          object: input.object,
          confidence: input.confidence ?? null,
          salience: input.salience ?? DEFAULT_BELIEF_SALIENCE,
          embedding: input.embedding ? [...input.embedding] : null,
          sensitive: isSensitiveMatter(input.predicate, input.object),
        })
        .returning();
      if (!created) {
        throw new Error('failed to record belief');
      }
      return toUserFactDto(created);
    });
  }

  async searchBeliefs(userId: string, params: BeliefSearchParams): Promise<readonly BeliefHit[]> {
    const filter = this.currentBeliefFilter(userId);
    // An empty query embedding (provider down, caller degraded) skips the vector arm —
    // lexical FTS still answers (mirrors the semantic/episodic hybrid).
    const distance = sql`${userFacts.embedding} <=> ${JSON.stringify([...params.queryEmbedding])}::vector`;
    // Relevance floor (Phase 12): when the caller sets `maxVectorDistance`, the vector
    // arm gates on distance, not just orders by it — so a far belief is never pulled in
    // just to fill the top-K. Without it, every belief surfaces while N ≤ topK, framed as
    // "relevant" when it's really "everything I know". The FTS arm needs no floor (a term
    // match is itself a relevance gate).
    const vectorWhere =
      params.maxVectorDistance === undefined
        ? and(filter, sql`${userFacts.embedding} IS NOT NULL`)
        : and(
            filter,
            sql`${userFacts.embedding} IS NOT NULL`,
            sql`${distance} <= ${params.maxVectorDistance}`,
          );
    const vectorRows =
      params.queryEmbedding.length === 0
        ? []
        : await this.db
            .select()
            .from(userFacts)
            .where(vectorWhere)
            .orderBy(distance)
            .limit(params.topK);
    const lexicalRows = await this.db
      .select()
      .from(userFacts)
      .where(and(filter, sql`${userFacts.fts} @@ plainto_tsquery('english', ${params.queryText})`))
      .orderBy(sql`ts_rank(${userFacts.fts}, plainto_tsquery('english', ${params.queryText})) DESC`)
      .limit(params.topK);
    // Lazy time-decay (Phase 13): score each belief's *effective* salience (stored ×
    // decay(now − updated_at)). A belief that has faded below the stale floor stops
    // surfacing entirely — dropped from both arms before fusion — while the rest have the
    // decayed value tilt the fused ranking (a reinforced belief rises, a faded one sinks).
    const now = params.now ?? new Date();
    const effective = (row: typeof userFacts.$inferSelect): number =>
      effectiveSalience(row.salience, row.updatedAt, now);
    const live = (rows: readonly (typeof userFacts.$inferSelect)[]) =>
      rows.filter((row) => !isStale(effective(row)));
    return reciprocalRankFusion(
      [live(vectorRows), live(lexicalRows)],
      (row) => row.id,
      params.topK,
      undefined,
      (row) => 1 + SALIENCE_RANK_WEIGHT * effective(row),
    ).map(({ item, score }) => ({ belief: toUserFactDto(item), score }));
  }

  async findSimilarBeliefs(
    userId: string,
    embedding: readonly number[],
    k: number,
  ): Promise<readonly UserFactDto[]> {
    if (embedding.length === 0) {
      return [];
    }
    const rows = await this.db
      .select()
      .from(userFacts)
      .where(and(this.currentBeliefFilter(userId), sql`${userFacts.embedding} IS NOT NULL`))
      .orderBy(sql`${userFacts.embedding} <=> ${JSON.stringify([...embedding])}::vector`)
      .limit(k);
    return rows.map(toUserFactDto);
  }

  async adjustBeliefSalience(
    userId: string,
    factId: string,
    delta: number,
  ): Promise<UserFactDto | null> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(userFacts)
        .where(and(eq(userFacts.id, factId), eq(userFacts.userId, userId)))
        .limit(1);
      if (!target) {
        return null;
      }
      const next = clamp01((target.salience ?? DEFAULT_BELIEF_SALIENCE) + delta);
      const [updated] = await tx
        .update(userFacts)
        .set({ salience: next, updatedAt: new Date() })
        .where(eq(userFacts.id, factId))
        .returning();
      return updated ? toUserFactDto(updated) : null;
    });
  }

  async replaceBelief(
    userId: string,
    oldFactId: string,
    replacement: RecordBeliefInput,
  ): Promise<UserFactDto | null> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: userFacts.id })
        .from(userFacts)
        .where(and(eq(userFacts.id, oldFactId), eq(userFacts.userId, userId)))
        .limit(1);
      if (!target) {
        return null;
      }
      // Current-state overlay: the same matter takes a newer state → overwrite the row IN
      // PLACE (no superseded chain; the timeline lives in episodic memory, ontology.md §4).
      const [updated] = await tx
        .update(userFacts)
        .set({
          source: replacement.source ?? 'transcript',
          learnedByCompanionId: replacement.learnedByCompanionId ?? null,
          learnedFromSeq: replacement.learnedFromSeq ?? null,
          predicate: replacement.predicate,
          object: replacement.object,
          confidence: replacement.confidence ?? null,
          salience: replacement.salience ?? DEFAULT_BELIEF_SALIENCE,
          embedding: replacement.embedding ? [...replacement.embedding] : null,
          sensitive: isSensitiveMatter(replacement.predicate, replacement.object),
          updatedAt: new Date(),
        })
        .where(eq(userFacts.id, target.id))
        .returning();
      return updated ? toUserFactDto(updated) : null;
    });
  }
}

function toUserFactDto(row: typeof userFacts.$inferSelect): UserFactDto {
  return {
    id: row.id,
    source: row.source,
    factType: row.factType,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    salience: row.salience,
    sensitive: row.sensitive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
