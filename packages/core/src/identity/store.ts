import type {
  CompanionDto,
  DriveWeights,
  PersonalityKnobs,
  ProactivityDial,
} from '@cobble/shared';
import { companions, type Database, users } from '@cobble/db';
import { and, eq } from 'drizzle-orm';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
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
  /** Null → neutral defaults; learned (EMA) by the reinforcement loop. */
  readonly driveWeights: DriveWeights | null;
  readonly createdAt: string;
}

/**
 * Identity Store — owns users and the companion "home" (architecture.md §3,
 * invariant #4). All companion reads are scoped by `ownerId` (invariant #5).
 */
export interface IdentityStore {
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
  /** Set the proactivity dial (Phase 4 tunability). Keyed by companionId. */
  setProactivityDial(companionId: string, dial: ProactivityDial): Promise<void>;
  /** Persist learned drive weights (Phase 4 reinforcement). Keyed by companionId. */
  updateDriveWeights(companionId: string, driveWeights: DriveWeights): Promise<void>;
}

export class DrizzleIdentityStore implements IdentityStore {
  constructor(private readonly db: Database) {}

  async ensureUserByEmail(email: string): Promise<UserRecord> {
    await this.db.insert(users).values({ email }).onConflictDoNothing();
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

  async createCompanion(ownerId: string, input: CreateCompanionInput): Promise<CompanionDto> {
    const [row] = await this.db
      .insert(companions)
      .values({ ownerId, ...input })
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
    await this.db
      .update(companions)
      .set({ driveWeights })
      .where(eq(companions.id, companionId));
  }
}

function toUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
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
