import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
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
 * API when a user saves their bot token; the service verifies it on `/link`. Shared
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
 * decoupled `@cobble/discord` service (which reads it on demand) can use it without importing
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
  /**
   * Mission wake (companion-missions.md §3.2): the allowlisted trigger-sender bot id and
   * the shared mission channel. A guild message is a valid mission trigger ONLY from
   * `triggerBotId` in `missionChannelId`. Both null until the mission wake is configured.
   */
  readonly triggerBotId: string | null;
  readonly missionChannelId: string | null;
  /**
   * The companion bot's OWN Discord user id (companion-missions.md §3.2), captured by the
   * gateway at ClientReady. Core reads it to build the mission scheduler action
   * (`<@botUserId> {{message}}`). Null until the bot first connects.
   */
  readonly botUserId: string | null;
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
  readonly triggerBotId: string | null;
  readonly missionChannelId: string | null;
  readonly botUserId: string | null;
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
    triggerBotId: row.triggerBotId,
    missionChannelId: row.missionChannelId,
    botUserId: row.botUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface DiscordConfigStore {
  findByUserId(userId: string): Promise<DiscordConfigRecord | null>;
  list(): Promise<DiscordConfigRecord[]>;
  upsert(input: DiscordConfigUpsert): Promise<DiscordConfigRecord>;
  reissueLinkCode(
    userId: string,
    linkCode: string,
    issuedAt: Date,
  ): Promise<DiscordConfigRecord | null>;
  bindOwner(userId: string, ownerDiscordUserId: string, expectedLinkCode: string): Promise<boolean>;
  /**
   * Set (or clear, with nulls) the mission-wake pair — the allowlisted trigger-sender bot
   * id and the shared mission channel (companion-missions.md §3.2). Independent of the
   * token/owner-lock upsert path, so configuring the mission wake never re-links the bot.
   * Returns null if there's no config row for the user.
   */
  configureMissionWake(
    userId: string,
    triggerBotId: string | null,
    missionChannelId: string | null,
  ): Promise<DiscordConfigRecord | null>;
  /**
   * Record the companion bot's own Discord user id, captured at ClientReady
   * (companion-missions.md §3.2). Idempotent — the gateway writes it on every connect.
   * Returns null if there's no config row for the user.
   */
  setBotUserId(userId: string, botUserId: string): Promise<DiscordConfigRecord | null>;
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

  /** Every configured bot — the service reads this at startup to (re)start gateways. */
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

  /**
   * Re-issue the single-use `/link` code WITHOUT touching the token or owner (the
   * settings "regenerate" action — used when a code expired before linking). Returns
   * null if there's no config row for the user.
   */
  async reissueLinkCode(
    userId: string,
    linkCode: string,
    issuedAt: Date,
  ): Promise<DiscordConfigRecord | null> {
    const [row] = await this.db
      .update(discordConfig)
      .set({ linkCode, linkCodeIssuedAt: issuedAt, updatedAt: new Date() })
      .where(eq(discordConfig.userId, userId))
      .returning();
    return row ? toRecord(row as DiscordConfigRow) : null;
  }

  /**
   * Atomically bind the owner's Discord id on a successful `/link`, clearing the
   * consumed code. The `WHERE` guards `link_code = expected AND owner IS NULL` so the
   * code is single-use under concurrency: two racing `/link` calls both pass the
   * router's check-then-act, but only the first matches this predicate — the second
   * sees the now-cleared code (0 rows) and is rejected. Returns whether this call
   * consumed the code.
   */
  async bindOwner(
    userId: string,
    ownerDiscordUserId: string,
    expectedLinkCode: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(discordConfig)
      .set({
        ownerDiscordUserId,
        linkCode: null,
        linkCodeIssuedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(discordConfig.userId, userId),
          eq(discordConfig.linkCode, expectedLinkCode),
          isNull(discordConfig.ownerDiscordUserId),
        ),
      )
      .returning();
    return rows.length > 0;
  }

  async configureMissionWake(
    userId: string,
    triggerBotId: string | null,
    missionChannelId: string | null,
  ): Promise<DiscordConfigRecord | null> {
    const [row] = await this.db
      .update(discordConfig)
      .set({ triggerBotId, missionChannelId, updatedAt: new Date() })
      .where(eq(discordConfig.userId, userId))
      .returning();
    return row ? toRecord(row as DiscordConfigRow) : null;
  }

  async setBotUserId(userId: string, botUserId: string): Promise<DiscordConfigRecord | null> {
    const [row] = await this.db
      .update(discordConfig)
      .set({ botUserId, updatedAt: new Date() })
      .where(eq(discordConfig.userId, userId))
      .returning();
    return row ? toRecord(row as DiscordConfigRow) : null;
  }

  async delete(userId: string): Promise<void> {
    await this.db.delete(discordConfig).where(eq(discordConfig.userId, userId));
  }
}
