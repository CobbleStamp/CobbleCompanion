/**
 * The User-Model store (Phase 11, docs/companion-memory.md §4) — persistence for
 * the companion's typed knowledge about its USER. Owns the `user_facts` table: the
 * Tier-1 core profile (identity attributes carried in the persona every turn).
 * Keyed by `user_id` (per-user; facts are objective truths shared across a user's
 * companions). Tier-2 belief accrual + retrieval arrive in Phase 12.
 *
 * Facts are revised by **superseding**, never overwriting: a new value is inserted as
 * current and the prior row is marked `superseded_at`/`superseded_by`, so history is
 * kept (ontology.md §4). SINGULAR predicates supersede the prior value for the
 * `(user_id, predicate)` (one current value); MULTI-VALUED predicates
 * (`MULTI_VALUED_PREDICATES`: languages, relationships) accrete and supersede only an
 * identical `(predicate, object)` restatement, so distinct values coexist.
 */
import { isMultiValuedPredicate, type UserFactDto } from '@cobble/shared';
import { type Database, userFacts } from '@cobble/db';
import { and, eq, isNull, ne } from 'drizzle-orm';

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
 * Persistence boundary for the User Model. All reads/writes are scoped by `userId`
 * (tenancy); edit/forget additionally verify the fact belongs to the user.
 *
 * The "one current row per `(userId, predicate)` for singular predicates" invariant is
 * enforced by the supersede-within-transaction writes here PLUS the harness serializing
 * captures per-user (harness.ts `userFactChains`), not by a DB unique constraint —
 * sufficient for the single-instance PoC (the affect store makes the same assumption).
 * Multi-valued predicates hold several current rows by design.
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
      // Insert the new current fact first so the prior row can point its
      // `superseded_by` at it (the replacement id must exist before the update).
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
      // Supersede the prior current value(s) for this predicate. A SINGULAR attribute
      // (name, age, …) keeps exactly one current value, so every other current row for
      // the predicate is superseded. A MULTI-VALUED attribute (languages, relationships)
      // accretes, so only an identical (predicate, object) restatement is collapsed —
      // distinct values coexist as separate current rows.
      await tx
        .update(userFacts)
        .set({ supersededAt: new Date(), supersededBy: created.id, updatedAt: new Date() })
        .where(
          and(
            eq(userFacts.userId, input.userId),
            eq(userFacts.predicate, input.predicate),
            isMultiValuedPredicate(input.predicate)
              ? eq(userFacts.object, input.object)
              : undefined,
            isNull(userFacts.supersededAt),
            ne(userFacts.id, created.id),
          ),
        );
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
        .returning();
      if (!created) {
        throw new Error('failed to seed user name');
      }
      return toUserFactDto(created);
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
        .set({ supersededAt: new Date(), supersededBy: created.id, updatedAt: new Date() })
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
