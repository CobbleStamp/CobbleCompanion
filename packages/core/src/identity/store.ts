import type { CompanionDto, DriveWeights, PersonalityKnobs, ProactivityDial } from '@cobble/shared';
import { companions, type Database, DEFAULT_STARTING_VITALITY_TOKENS, users } from '@cobble/db';
import { and, eq } from 'drizzle-orm';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  /** What the companion calls the user; null until seeded from Google or learned. */
  readonly displayName: string | null;
  readonly createdAt: string;
}

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
  // Phase 4 — proactivity state the motivation engine reads (companion-motivation.md).
  readonly proactivityDial: ProactivityDial;
  /** Null until personalized via onboarding (PoC uses default constants). */
  readonly personalityKnobs: PersonalityKnobs | null;
  /** Null → neutral defaults; learned (additive change-as-reward nudge) by the reinforcement loop. */
  readonly driveWeights: DriveWeights | null;
  readonly createdAt: string;
}

/**
 * Identity Store — owns users and the companion "home" (architecture.md §3,
 * invariant #4). All companion reads are scoped by `ownerId` (invariant #5).
 */
export interface IdentityStore {
  /**
   * JIT-provision the user for a verified email, returning the row. `seedName` is
   * the Google ID token's (unverified) display name: it is written ONLY when the
   * row is first created, never on a later sign-in — so a name later persisted via
   * {@link setUserDisplayName} is never clobbered by Google.
   */
  ensureUserByEmail(email: string, seedName?: string): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  /**
   * Persist the name the user wants to be called — authoritative over the Google
   * seed; keyed by userId. NOTE: no caller yet. The path that captures a name the
   * user states in conversation is not built (it is the open design question — see
   * docs/companion-memory.md). Today `display_name` is only ever set by the Google
   * seed in {@link ensureUserByEmail}; this method is the persistence primitive
   * that capture path will use.
   */
  setUserDisplayName(userId: string, displayName: string): Promise<void>;
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

  async ensureUserByEmail(email: string, seedName?: string): Promise<UserRecord> {
    // Set-once seed: `onConflictDoNothing` means an existing user keeps whatever
    // display name they already have (Google seed or a confirmed name), so a later
    // sign-in never overwrites it. A trimmed-empty seed is treated as absent.
    const displayName = seedName?.trim() ? seedName.trim() : undefined;
    await this.db
      .insert(users)
      .values({ email, ...(displayName ? { displayName } : {}) })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!row) {
      throw new Error('failed to ensure user by email');
    }
    return toUserRecord(row);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUserRecord(row) : null;
  }

  async setUserDisplayName(userId: string, displayName: string): Promise<void> {
    await this.db.update(users).set({ displayName }).where(eq(users.id, userId));
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
    email: row.email,
    displayName: row.displayName,
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
    proactivityDial: row.proactivityDial,
    personalityKnobs: row.personalityKnobs,
    driveWeights: row.driveWeights,
    createdAt: row.createdAt.toISOString(),
  };
}
