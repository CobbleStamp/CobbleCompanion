import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { discordConfig } from './schema.js';

/**
 * No-look-alike alphabet for the single-use `/link` code (no 0/O/1/I/L). Its length
 * (32) divides 256 evenly, so `randomBytes` mod 32 is unbiased.
 */
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** `/link` code length. */
export const LINK_CODE_LENGTH = 8;

/**
 * Generate a fresh single-use `/link` code (companion-discord.md §9). Minted by the
 * API when a user saves their bot token; the worker verifies it on `/link`. Shared
 * here so the API and any tooling produce the same shape.
 */
export function generateLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    code += LINK_CODE_ALPHABET[(bytes[i] as number) % LINK_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Data access for `discord_config` (companion-discord.md §9). Lives in `@cobble/db`
 * — the shared data layer — so BOTH the api (which writes it on behalf of the web
 * settings panel, and reads it to authorize the token-mint endpoint) and the
 * decoupled `@cobble/discord` worker (which polls it) can use it without importing
 * each other or `@cobble/core`.
 */

export interface DiscordConfigRecord {
  readonly userId: string;
  readonly encryptedBotToken: string;
  readonly boundCompanionId: string;
  /** Null until the one-time `/link` handshake binds the owner's Discord user id. */
  readonly ownerDiscordUserId: string | null;
  /** The single-use `/link` code, or null once consumed / never issued. */
  readonly linkCode: string | null;
  readonly linkCodeIssuedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The fields the settings panel supplies when saving a bot (the API write path). */
export interface DiscordConfigUpsert {
  readonly userId: string;
  readonly encryptedBotToken: string;
  readonly boundCompanionId: string;
  readonly linkCode: string;
  readonly linkCodeIssuedAt: Date;
}

interface DiscordConfigRow {
  readonly userId: string;
  readonly encryptedBotToken: string;
  readonly boundCompanionId: string;
  readonly ownerDiscordUserId: string | null;
  readonly linkCode: string | null;
  readonly linkCodeIssuedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: DiscordConfigRow): DiscordConfigRecord {
  return {
    userId: row.userId,
    encryptedBotToken: row.encryptedBotToken,
    boundCompanionId: row.boundCompanionId,
    ownerDiscordUserId: row.ownerDiscordUserId,
    linkCode: row.linkCode,
    linkCodeIssuedAt: row.linkCodeIssuedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface DiscordConfigStore {
  findByUserId(userId: string): Promise<DiscordConfigRecord | null>;
  list(): Promise<DiscordConfigRecord[]>;
  upsert(input: DiscordConfigUpsert): Promise<DiscordConfigRecord>;
  bindOwner(userId: string, ownerDiscordUserId: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

export class DrizzleDiscordConfigStore implements DiscordConfigStore {
  constructor(private readonly db: Database) {}

  async findByUserId(userId: string): Promise<DiscordConfigRecord | null> {
    const [row] = await this.db
      .select()
      .from(discordConfig)
      .where(eq(discordConfig.userId, userId))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  /** Every configured bot — the worker's poll reads this to (re)start gateways. */
  async list(): Promise<DiscordConfigRecord[]> {
    const rows = await this.db.select().from(discordConfig);
    return rows.map(toRecord);
  }

  /**
   * Create or replace a user's bot config (the settings save). A (re)save resets the
   * owner lock and issues a fresh `/link` code — changing the token means re-linking.
   */
  async upsert(input: DiscordConfigUpsert): Promise<DiscordConfigRecord> {
    const now = new Date();
    const [row] = await this.db
      .insert(discordConfig)
      .values({
        userId: input.userId,
        encryptedBotToken: input.encryptedBotToken,
        boundCompanionId: input.boundCompanionId,
        ownerDiscordUserId: null,
        linkCode: input.linkCode,
        linkCodeIssuedAt: input.linkCodeIssuedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: discordConfig.userId,
        set: {
          encryptedBotToken: input.encryptedBotToken,
          boundCompanionId: input.boundCompanionId,
          ownerDiscordUserId: null,
          linkCode: input.linkCode,
          linkCodeIssuedAt: input.linkCodeIssuedAt,
          updatedAt: now,
        },
      })
      .returning();
    // `returning()` always yields the affected row on insert-or-update.
    return toRecord(row as DiscordConfigRow);
  }

  /** Bind the owner's Discord id on a successful `/link`, clearing the consumed code. */
  async bindOwner(userId: string, ownerDiscordUserId: string): Promise<void> {
    await this.db
      .update(discordConfig)
      .set({
        ownerDiscordUserId,
        linkCode: null,
        linkCodeIssuedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(discordConfig.userId, userId));
  }

  async delete(userId: string): Promise<void> {
    await this.db.delete(discordConfig).where(eq(discordConfig.userId, userId));
  }
}
