import type { CompanionDto, DriveWeights, PersonalityKnobs, ProactivityDial } from '@cobble/shared';
import { companions, type Database, DEFAULT_STARTING_VITALITY_TOKENS, users } from '@cobble/db';
import { and, eq } from 'drizzle-orm';

export interface UserRecord {
  readonly id: string;
  /** How this user authenticates: `google` (email-keyed) or `service` (external_id-keyed). */
  readonly authSource: string;
  /** The owning service consumer (`service_registry.client_id`) when `authSource = 'service'`; null for `google`. */
  readonly serviceClientId: string | null;
  /** The consumer's opaque id when `authSource = 'service'`; null for `google`. */
  readonly externalId: string | null;
  /** Login identity when `authSource = 'google'`; null for `service` (no email). */
  readonly email: string | null;
  readonly createdAt: string;
}

/**
 * The identity dimension a user is provisioned/looked-up by, discriminated by
 * `auth_source` (implementation.md §1, §5). Google Sign-In (and `dev_bypass`)
 * resolve by verified `email`; a trusted server-to-server consumer resolves by the
 * `(clientId, externalId)` it asserts — `clientId` namespaces `externalId` so two
 * consumers can reuse the same id without colliding. The verifier produces this from
 * a request; the store turns it into a `users` row via
 * {@link IdentityStore.ensureUserByClaim}.
 */
export type UserClaim =
  | { readonly authSource: 'google'; readonly email: string }
  | { readonly authSource: 'service'; readonly clientId: string; readonly externalId: string };

export interface CreateCompanionInput {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
}

/**
 * The full companion "home" row, including owner + Phase 2 personality state
 * (`evolvedPersona` and the evolution/consolidation cursors). Returned only to
 * BACKGROUND workers via {@link IdentityStore.getCompanionById}; surfaces get the
 * trimmed `CompanionDto`.
 */
export interface CompanionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly evolvedPersona: string | null;
  readonly personaUpdatedThroughSeq: number;
  readonly consolidatedThroughSeq: number;
  /** Phase 12 — the User-Model Reflector's belief-extraction cursor (independent). */
  readonly userFactsThroughSeq: number;
  /** Phase 13 — Tier-3 synthesized user persona ("who this person is to you"); null until first synthesis. */
  readonly userPersona: string | null;
  /** Phase 13 — the Tier-3 synthesis cursor (independent; mirrors `personaUpdatedThroughSeq`). */
  readonly userModelUpdatedThroughSeq: number;
  // Phase 4 — proactivity state the motivation engine reads (companion-motivation.md).
  readonly proactivityDial: ProactivityDial;
  /** Null until personalized via onboarding (PoC uses default constants). */
  readonly personalityKnobs: PersonalityKnobs | null;
  /** Null → neutral defaults; learned (additive change-as-reward nudge) by the reinforcement loop. */
  readonly driveWeights: DriveWeights | null;
  readonly createdAt: string;
  /**
   * Phase 14 — the durable "when the user was last here" timestamp the greeting
   * gate computes its arrival gap from. `null` = never seen = a first meeting
   * (the introduction overrides the dial, companion-greeting.md §3–§4).
   */
  readonly lastSeenAt: string | null;
}

/**
 * Identity Store — owns users and the companion "home" (architecture.md §3,
 * invariant #4). All companion reads are scoped by `ownerId` (invariant #5).
 */
export interface IdentityStore {
  /**
   * JIT-provision the user for a verified auth claim, returning the row. Idempotent —
   * a later request with the same claim returns the existing row. `google` claims key
   * on `email`; `service` claims key on `(auth_source, external_id)`. The user's NAME
   * is not stored here: it is a Tier-1 `user_fact` (seeded from the Google name claim
   * or the `X-User-Name` header by the auth boundary, then refined in conversation —
   * companion-memory.md §4, user-model/store.ts).
   */
  ensureUserByClaim(claim: UserClaim): Promise<UserRecord>;
  /** Convenience wrapper for a Google/email claim — see {@link ensureUserByClaim}. */
  ensureUserByEmail(email: string): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  createCompanion(ownerId: string, input: CreateCompanionInput): Promise<CompanionDto>;
  getCompanion(id: string, ownerId: string): Promise<CompanionDto | null>;
  /**
   * Unscoped companion lookup for BACKGROUND workers only (episodic
   * consolidation / personality evolution), which run by companionId after the
   * triggering request already established owner scope, or off a system sweep.
   * Never reachable from a user request path — those use the owner-scoped
   * {@link getCompanion} (invariant #5). Mirrors the cross-companion system
   * reads the deferred-ingestion sweeper already makes. Returns the full
   * {@link CompanionRecord} (owner + personality state) those workers need.
   */
  getCompanionById(companionId: string): Promise<CompanionRecord | null>;
  listCompanions(ownerId: string): Promise<readonly CompanionDto[]>;
  /**
   * Persist the re-synthesized evolved persona and advance the evolution cursor
   * (`personaUpdatedThroughSeq`) — a BACKGROUND write from the personality
   * evolver, keyed by companionId after the consolidation that triggered it.
   */
  updateEvolvedPersona(
    companionId: string,
    evolvedPersona: string,
    personaUpdatedThroughSeq: number,
  ): Promise<void>;
  /**
   * Advance the User-Model Reflector's belief-extraction cursor
   * (`userFactsThroughSeq`) — a BACKGROUND write from the reflector, keyed by
   * companionId. Independent of the consolidation/evolution cursors (Phase 12).
   */
  advanceUserFactsThroughSeq(companionId: string, throughSeq: number): Promise<void>;
  /**
   * Persist the synthesized Tier-3 user persona and advance its cursor
   * (`userModelUpdatedThroughSeq`) — a BACKGROUND write from the user-persona
   * synthesizer, keyed by companionId. Independent of the other cursors (Phase 13).
   */
  updateUserPersona(
    companionId: string,
    userPersona: string,
    userModelUpdatedThroughSeq: number,
  ): Promise<void>;
  /**
   * Stamp the companion's arrival clock to `at` (Phase 14 greeting). Called AFTER
   * the greeting gate has read the prior value to compute the gap, so the next
   * arrival check sees the fresh value and an idle return doesn't re-greet
   * (companion-greeting.md §3). Keyed by companionId (a background/arrival write).
   */
  markSeen(companionId: string, at: Date): Promise<void>;
  /** Set the proactivity dial (Phase 4 tunability). Keyed by companionId. */
  setProactivityDial(companionId: string, dial: ProactivityDial): Promise<void>;
  /** Persist learned drive weights (Phase 4 reinforcement). Keyed by companionId. */
  updateDriveWeights(companionId: string, driveWeights: DriveWeights): Promise<void>;
}

export interface DrizzleIdentityStoreOptions {
  /**
   * Tokens each new companion's stamina + energy wallets are seeded with at
   * creation (architecture.md §4.8). Defaults to the schema default; production
   * passes `STARTING_VITALITY_TOKENS` through here so the env override takes effect.
   */
  readonly startingVitalityTokens?: number;
}

export class DrizzleIdentityStore implements IdentityStore {
  private readonly startingVitalityTokens: number;

  constructor(
    private readonly db: Database,
    options: DrizzleIdentityStoreOptions = {},
  ) {
    const seed = options.startingVitalityTokens ?? DEFAULT_STARTING_VITALITY_TOKENS;
    // Validate at construction so a bad seed fails loudly here rather than writing a
    // corrupt wallet (negative balance, or a fractional value the bigint column would
    // silently coerce) into every companion this store creates. The env path already
    // enforces this via Zod, but the option is taken on trust from any caller.
    if (!Number.isInteger(seed) || seed < 0) {
      throw new RangeError(`startingVitalityTokens must be a non-negative integer, got ${seed}`);
    }
    this.startingVitalityTokens = seed;
  }

  async ensureUserByClaim(claim: UserClaim): Promise<UserRecord> {
    // `onConflictDoNothing` makes provisioning idempotent: an existing user is left
    // untouched and re-read below. The name lives in `user_facts`, not here. Each
    // branch inserts and re-reads on the claim's own key (email for google; the
    // (auth_source, external_id) partial-unique index for service).
    if (claim.authSource === 'google') {
      await this.db
        .insert(users)
        .values({ authSource: 'google', email: claim.email })
        .onConflictDoNothing();
      const [row] = await this.db.select().from(users).where(eq(users.email, claim.email)).limit(1);
      if (!row) {
        throw new Error('failed to ensure user by google claim');
      }
      return toUserRecord(row);
    }
    await this.db
      .insert(users)
      .values({
        authSource: 'service',
        serviceClientId: claim.clientId,
        externalId: claim.externalId,
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.authSource, 'service'),
          eq(users.serviceClientId, claim.clientId),
          eq(users.externalId, claim.externalId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new Error('failed to ensure user by service claim');
    }
    return toUserRecord(row);
  }

  async ensureUserByEmail(email: string): Promise<UserRecord> {
    return this.ensureUserByClaim({ authSource: 'google', email });
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUserRecord(row) : null;
  }

  async createCompanion(ownerId: string, input: CreateCompanionInput): Promise<CompanionDto> {
    const [row] = await this.db
      .insert(companions)
      .values({
        ownerId,
        ...input,
        // Seed both vitality wallets at creation (architecture.md §4.8); the store
        // meters these columns thereafter.
        staminaBalanceTokens: this.startingVitalityTokens,
        energyBalanceTokens: this.startingVitalityTokens,
      })
      .returning();
    if (!row) {
      throw new Error('failed to create companion');
    }
    return toCompanionDto(row);
  }

  async getCompanion(id: string, ownerId: string): Promise<CompanionDto | null> {
    const [row] = await this.db
      .select()
      .from(companions)
      .where(and(eq(companions.id, id), eq(companions.ownerId, ownerId)))
      .limit(1);
    return row ? toCompanionDto(row) : null;
  }

  async getCompanionById(companionId: string): Promise<CompanionRecord | null> {
    const [row] = await this.db
      .select()
      .from(companions)
      .where(eq(companions.id, companionId))
      .limit(1);
    return row ? toCompanionRecord(row) : null;
  }

  async listCompanions(ownerId: string): Promise<readonly CompanionDto[]> {
    const rows = await this.db.select().from(companions).where(eq(companions.ownerId, ownerId));
    return rows.map(toCompanionDto);
  }

  async updateEvolvedPersona(
    companionId: string,
    evolvedPersona: string,
    personaUpdatedThroughSeq: number,
  ): Promise<void> {
    await this.db
      .update(companions)
      .set({ evolvedPersona, personaUpdatedThroughSeq })
      .where(eq(companions.id, companionId));
  }

  async advanceUserFactsThroughSeq(companionId: string, throughSeq: number): Promise<void> {
    await this.db
      .update(companions)
      .set({ userFactsThroughSeq: throughSeq })
      .where(eq(companions.id, companionId));
  }

  async updateUserPersona(
    companionId: string,
    userPersona: string,
    userModelUpdatedThroughSeq: number,
  ): Promise<void> {
    await this.db
      .update(companions)
      .set({ userPersona, userModelUpdatedThroughSeq })
      .where(eq(companions.id, companionId));
  }

  async markSeen(companionId: string, at: Date): Promise<void> {
    await this.db.update(companions).set({ lastSeenAt: at }).where(eq(companions.id, companionId));
  }

  async setProactivityDial(companionId: string, dial: ProactivityDial): Promise<void> {
    await this.db
      .update(companions)
      .set({ proactivityDial: dial })
      .where(eq(companions.id, companionId));
  }

  async updateDriveWeights(companionId: string, driveWeights: DriveWeights): Promise<void> {
    await this.db.update(companions).set({ driveWeights }).where(eq(companions.id, companionId));
  }
}

function toUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    authSource: row.authSource,
    serviceClientId: row.serviceClientId,
    externalId: row.externalId,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
  };
}

function toCompanionDto(row: typeof companions.$inferSelect): CompanionDto {
  return {
    id: row.id,
    name: row.name,
    form: row.form,
    temperament: row.temperament,
    evolvedPersona: row.evolvedPersona,
    userPersona: row.userPersona,
    proactivityDial: row.proactivityDial,
    createdAt: row.createdAt.toISOString(),
  };
}

function toCompanionRecord(row: typeof companions.$inferSelect): CompanionRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    form: row.form,
    temperament: row.temperament,
    evolvedPersona: row.evolvedPersona,
    personaUpdatedThroughSeq: row.personaUpdatedThroughSeq,
    consolidatedThroughSeq: row.consolidatedThroughSeq,
    userFactsThroughSeq: row.userFactsThroughSeq,
    userPersona: row.userPersona,
    userModelUpdatedThroughSeq: row.userModelUpdatedThroughSeq,
    proactivityDial: row.proactivityDial,
    personalityKnobs: row.personalityKnobs,
    driveWeights: row.driveWeights,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
  };
}
