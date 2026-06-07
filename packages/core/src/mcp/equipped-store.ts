/**
 * The per-companion **equipped set** (companion-tools.md §4) — the tools a
 * companion has loaded on demand, each with the fresh schema snapshot so the
 * per-step registry (equipped-resolver.ts) rebuilds without a network round-trip.
 *
 * A single bounded tier: at most `maxEquippedTools` tools, pruned by LRU
 * (`lastUsedAt`) when a new load would exceed the cap — "you can't carry
 * everything." There is no always-on tier here; the fixed *core* tools live in
 * code (never in this table), and tools the companion anticipates needing are
 * loaded proactively from procedural memory (§5) but are otherwise ordinary
 * equipped tools. No secrets are stored: auth is resolved from the whitelist at
 * call time (§7).
 */

import { type Database, equippedTools } from '@cobble/db';
import type { McpToolSnapshot, ToolSource } from '@cobble/shared';
import { and, asc, eq } from 'drizzle-orm';

export interface EquippedToolRecord {
  readonly companionId: string;
  readonly toolId: string;
  readonly source: ToolSource;
  readonly serverRef: string;
  readonly snapshot: McpToolSnapshot;
  readonly equippedAt: Date;
  readonly lastUsedAt: Date;
}

export interface EquipInput {
  readonly toolId: string;
  readonly source: ToolSource;
  readonly serverRef: string;
  /** The tool's fresh schema, fetched at load time. */
  readonly snapshot: McpToolSnapshot;
}

export interface EquippedToolStore {
  /** Load (or refresh) a tool into the companion's equipped set. */
  equip(companionId: string, input: EquipInput): Promise<EquippedToolRecord>;
  /** The companion's equipped tools — drives the per-step registry rebuild. */
  list(companionId: string): Promise<readonly EquippedToolRecord[]>;
  /** Mark a tool used: bump `lastUsedAt` so it is the most-recently-used (LRU). */
  touch(companionId: string, toolId: string): Promise<void>;
  /**
   * Enforce the equipped-tool cap: keep at most `maxEquippedTools`, evicting the
   * least-recently-used. Returns the number evicted.
   */
  evictToMaxEquipped(companionId: string, maxEquippedTools: number): Promise<number>;
  get(companionId: string, toolId: string): Promise<EquippedToolRecord | null>;
}

export interface EquippedStoreOptions {
  /** Clock seam for deterministic tests (default `() => new Date()`). */
  readonly now?: () => Date;
}

/** Postgres-backed equipped set (the `equipped_tools` table). */
export class DrizzleEquippedToolStore implements EquippedToolStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: EquippedStoreOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  async equip(companionId: string, input: EquipInput): Promise<EquippedToolRecord> {
    const now = this.now();
    const [row] = await this.db
      .insert(equippedTools)
      .values({
        companionId,
        toolId: input.toolId,
        source: input.source,
        serverRef: input.serverRef,
        snapshot: input.snapshot,
        equippedAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [equippedTools.companionId, equippedTools.toolId],
        // Re-loading refreshes the schema and bumps recency.
        set: {
          source: input.source,
          serverRef: input.serverRef,
          snapshot: input.snapshot,
          lastUsedAt: now,
        },
      })
      .returning();
    if (!row) {
      throw new Error('failed to equip tool');
    }
    return toRecord(row);
  }

  async list(companionId: string): Promise<readonly EquippedToolRecord[]> {
    const rows = await this.db
      .select()
      .from(equippedTools)
      .where(eq(equippedTools.companionId, companionId));
    return rows.map(toRecord);
  }

  async touch(companionId: string, toolId: string): Promise<void> {
    await this.db
      .update(equippedTools)
      .set({ lastUsedAt: this.now() })
      .where(and(eq(equippedTools.companionId, companionId), eq(equippedTools.toolId, toolId)));
  }

  async evictToMaxEquipped(companionId: string, maxEquippedTools: number): Promise<number> {
    const rows = await this.db
      .select({ id: equippedTools.id, lastUsedAt: equippedTools.lastUsedAt })
      .from(equippedTools)
      .where(eq(equippedTools.companionId, companionId))
      .orderBy(asc(equippedTools.lastUsedAt));
    const evict = rows.slice(0, Math.max(0, rows.length - maxEquippedTools));
    for (const record of evict) {
      await this.db.delete(equippedTools).where(eq(equippedTools.id, record.id));
    }
    return evict.length;
  }

  async get(companionId: string, toolId: string): Promise<EquippedToolRecord | null> {
    const [row] = await this.db
      .select()
      .from(equippedTools)
      .where(and(eq(equippedTools.companionId, companionId), eq(equippedTools.toolId, toolId)))
      .limit(1);
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: typeof equippedTools.$inferSelect): EquippedToolRecord {
  return {
    companionId: row.companionId,
    toolId: row.toolId,
    source: row.source,
    serverRef: row.serverRef,
    snapshot: row.snapshot,
    equippedAt: row.equippedAt,
    lastUsedAt: row.lastUsedAt,
  };
}
