/**
 * The User-Model store (docs/companion-memory.md §4) — persistence for the companion's
 * typed knowledge about its USER. Owns the `user_facts` table: the Tier-1 core profile
 * (identity attributes carried in the persona every turn, Phase 11) and the Tier-2
 * learned-belief overlay (preferences/interests/opinions, hybrid-recalled, Phase 12).
 * Keyed by `user_id` (per-user; facts are objective truths shared across a user's
 * companions).
 *
 * Facts are revised by **superseding**, never overwriting: a new value is inserted as
 * current and the prior row is marked `superseded_at`/`superseded_by`, so history is
 * kept (ontology.md §4). SINGULAR predicates supersede the prior value for the
 * `(user_id, predicate)` (one current value); MULTI-VALUED predicates
 * (`MULTI_VALUED_PREDICATES`: languages, relationships) accrete and supersede only an
 * identical `(predicate, object)` restatement, so distinct values coexist.
 */
import {
  isMultiValuedPredicate,
  TIER2_PREDICATES,
  type UserFactDto,
  type UserFactSource,
} from '@cobble/shared';
import { type Database, userFacts } from '@cobble/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { reciprocalRankFusion } from '../memory/rrf.js';

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
   *  keep one current value; multi-valued ones accrete (`MULTI_VALUED_PREDICATES`). */
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
}

/**
 * Persistence boundary for the User Model. All reads/writes are scoped by `userId`
 * (tenancy); edit/forget additionally verify the fact belongs to the user.
 *
 * The "one current row per `(userId, predicate)` for singular predicates" invariant is
 * enforced by the supersede-within-transaction writes here PLUS the harness serializing
 * captures per-user (harness.ts `userFactChains`). For `name` specifically — seeded on
 * every authed request from auth-guard.ts, OUTSIDE that serialization — a partial unique
 * index (`user_facts_one_current_name_uniq`) also enforces it at the DB, so parallel
 * first-load seeds cannot double-insert; seedName absorbs the conflict. Other singular
 * predicates rely on serialization alone (sufficient for the single-instance PoC; the
 * affect store makes the same assumption). Multi-valued predicates hold several current
 * rows by design.
 */
export interface UserModelStore {
  /** Every current (non-superseded) fact for the user, oldest-first. */
  listCurrent(userId: string): Promise<readonly UserFactDto[]>;
  /**
   * Record an identity attribute learned in conversation. A singular predicate
   * supersedes the prior current value for the same `(userId, predicate)`; a
   * multi-valued one accretes, superseding only an identical `(predicate, object)`
   * restatement. Returns the new fact.
   */
  recordTranscriptFact(input: RecordTranscriptFactInput): Promise<UserFactDto>;
  /**
   * Seed the user's name from the sign-in provider — only if no `name` fact exists
   * at all (current OR superseded), so a later sign-in can never resurrect the seed
   * over a name the user has since stated or edited. Returns the seeded fact, or null
   * when a name already exists (no-op). Called once, when the user is first created.
   */
  seedName(userId: string, name: string): Promise<UserFactDto | null>;
  /**
   * Apply a user edit to one of their facts: supersede it and insert an authoritative
   * `user_edit` replacement with the same predicate. Returns the new fact, or null if
   * the fact is not found, not owned by the user, or already superseded.
   */
  editFact(userId: string, factId: string, object: string): Promise<UserFactDto | null>;
  /**
   * Forget a fact (supersede with no replacement) so it leaves the current set and
   * never resurfaces. Returns false if the fact is not a current fact owned by the user.
   */
  forgetFact(userId: string, factId: string): Promise<boolean>;

  // --- Tier-2 learned beliefs (Phase 12) ---

  /** Every current (non-superseded) Tier-2 belief for the user, most-recently-touched first. */
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
   * Supersede a current belief with a newer-state replacement (the reflector's
   * `supersede` op — current-state last-wins, the old row retained as history). Returns
   * the new belief, or null if the old isn't a current fact owned by the user.
   */
  supersedeBelief(
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
      .where(and(eq(userFacts.userId, userId), isNull(userFacts.supersededAt)))
      .orderBy(userFacts.createdAt);
    return rows.map(toUserFactDto);
  }

  async recordTranscriptFact(input: RecordTranscriptFactInput): Promise<UserFactDto> {
    return this.db.transaction(async (tx) => {
      // Supersede the prior current value(s) for this predicate BEFORE inserting the
      // replacement. A SINGULAR attribute (name, age, …) keeps exactly one current value,
      // so every current row for the predicate is superseded. A MULTI-VALUED attribute
      // (languages, relationships) accretes, so only an identical (predicate, object)
      // restatement is collapsed — distinct values coexist as separate current rows.
      //
      // Order matters: the `name` partial unique index (one current `name` per user)
      // forbids two current rows even transiently, so we cannot insert-then-supersede.
      // We supersede first (setting only `superseded_at`, so the rows leave the index),
      // insert the lone current row, then back-fill `superseded_by` — which FK-references
      // the new row and so must be set after it exists.
      const superseded = await tx
        .update(userFacts)
        .set({ supersededAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(userFacts.userId, input.userId),
            eq(userFacts.predicate, input.predicate),
            isMultiValuedPredicate(input.predicate)
              ? eq(userFacts.object, input.object)
              : undefined,
            isNull(userFacts.supersededAt),
          ),
        )
        .returning({ id: userFacts.id });
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
        })
        .returning();
      if (!created) {
        throw new Error('failed to record user fact');
      }
      if (superseded.length > 0) {
        await tx
          .update(userFacts)
          .set({ supersededBy: created.id })
          .where(
            inArray(
              userFacts.id,
              superseded.map((row) => row.id),
            ),
          );
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
      // Resurrection guard: any name fact (current OR superseded) means the user
      // already has a name (seeded, stated, or edited) — never seed over it.
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
        .where(
          and(
            eq(userFacts.id, factId),
            eq(userFacts.userId, userId),
            isNull(userFacts.supersededAt),
          ),
        )
        .limit(1);
      if (!target) {
        return null;
      }
      // Supersede the target first so it leaves the `name` partial unique index before
      // the replacement is inserted (one current `name` per user, enforced even within a
      // transaction); `superseded_by` is back-filled after the insert since it
      // FK-references the new row. See recordTranscriptFact for the same ordering.
      await tx
        .update(userFacts)
        .set({ supersededAt: new Date(), updatedAt: new Date() })
        .where(eq(userFacts.id, target.id));
      const [created] = await tx
        .insert(userFacts)
        .values({
          userId,
          source: 'user_edit',
          factType: target.factType,
          subject: target.subject,
          predicate: target.predicate,
          object: trimmed,
          confidence: USER_EDIT_CONFIDENCE,
        })
        .returning();
      if (!created) {
        throw new Error('failed to edit user fact');
      }
      await tx
        .update(userFacts)
        .set({ supersededBy: created.id })
        .where(eq(userFacts.id, target.id));
      return toUserFactDto(created);
    });
  }

  async forgetFact(userId: string, factId: string): Promise<boolean> {
    const forgotten = await this.db
      .update(userFacts)
      .set({ supersededAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(userFacts.id, factId), eq(userFacts.userId, userId), isNull(userFacts.supersededAt)),
      )
      .returning({ id: userFacts.id });
    return forgotten.length > 0;
  }

  // --- Tier-2 learned beliefs (Phase 12) ---

  /** The shared filter: a user's current (non-superseded) Tier-2 belief rows. */
  private currentBeliefFilter(userId: string) {
    return and(
      eq(userFacts.userId, userId),
      isNull(userFacts.supersededAt),
      inArray(userFacts.predicate, [...TIER2_PREDICATES]),
    );
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
            isNull(userFacts.supersededAt),
          ),
        )
        .limit(1);
      if (existing) {
        const next = clamp01(
          (existing.salience ?? DEFAULT_BELIEF_SALIENCE) + BELIEF_REINFORCE_STEP,
        );
        const [bumped] = await tx
          .update(userFacts)
          .set({ salience: next, updatedAt: new Date() })
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
    const vectorRows =
      params.queryEmbedding.length === 0
        ? []
        : await this.db
            .select()
            .from(userFacts)
            .where(and(filter, sql`${userFacts.embedding} IS NOT NULL`))
            .orderBy(
              sql`${userFacts.embedding} <=> ${JSON.stringify([...params.queryEmbedding])}::vector`,
            )
            .limit(params.topK);
    const lexicalRows = await this.db
      .select()
      .from(userFacts)
      .where(and(filter, sql`${userFacts.fts} @@ plainto_tsquery('english', ${params.queryText})`))
      .orderBy(sql`ts_rank(${userFacts.fts}, plainto_tsquery('english', ${params.queryText})) DESC`)
      .limit(params.topK);
    return reciprocalRankFusion([vectorRows, lexicalRows], (row) => row.id, params.topK).map(
      ({ item, score }) => ({ belief: toUserFactDto(item), score }),
    );
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
        .where(
          and(
            eq(userFacts.id, factId),
            eq(userFacts.userId, userId),
            isNull(userFacts.supersededAt),
          ),
        )
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

  async supersedeBelief(
    userId: string,
    oldFactId: string,
    replacement: RecordBeliefInput,
  ): Promise<UserFactDto | null> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(userFacts)
        .where(
          and(
            eq(userFacts.id, oldFactId),
            eq(userFacts.userId, userId),
            isNull(userFacts.supersededAt),
          ),
        )
        .limit(1);
      if (!target) {
        return null;
      }
      await tx
        .update(userFacts)
        .set({ supersededAt: new Date(), updatedAt: new Date() })
        .where(eq(userFacts.id, oldFactId));
      const [created] = await tx
        .insert(userFacts)
        .values({
          userId,
          source: replacement.source ?? 'transcript',
          learnedByCompanionId: replacement.learnedByCompanionId ?? null,
          learnedFromSeq: replacement.learnedFromSeq ?? null,
          factType: BELIEF_FACT_TYPE,
          subject: USER_SUBJECT,
          predicate: replacement.predicate,
          object: replacement.object,
          confidence: replacement.confidence ?? null,
          salience: replacement.salience ?? DEFAULT_BELIEF_SALIENCE,
          embedding: replacement.embedding ? [...replacement.embedding] : null,
        })
        .returning();
      if (!created) {
        throw new Error('failed to supersede belief');
      }
      await tx
        .update(userFacts)
        .set({ supersededBy: created.id })
        .where(eq(userFacts.id, oldFactId));
      return toUserFactDto(created);
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
