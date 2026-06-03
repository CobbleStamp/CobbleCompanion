import type { CompanionDto } from '@cobble/shared';
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
 * Identity Store — owns users and the companion "home" (architecture.md §3,
 * invariant #4). All companion reads are scoped by `ownerId` (invariant #5).
 */
export interface IdentityStore {
  ensureUserByEmail(email: string): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  createCompanion(ownerId: string, input: CreateCompanionInput): Promise<CompanionDto>;
  getCompanion(id: string, ownerId: string): Promise<CompanionDto | null>;
  listCompanions(ownerId: string): Promise<readonly CompanionDto[]>;
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

  async listCompanions(ownerId: string): Promise<readonly CompanionDto[]> {
    const rows = await this.db.select().from(companions).where(eq(companions.ownerId, ownerId));
    return rows.map(toCompanionDto);
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
    createdAt: row.createdAt.toISOString(),
  };
}
