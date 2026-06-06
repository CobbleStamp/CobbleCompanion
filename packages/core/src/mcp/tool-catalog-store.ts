/**
 * The deployment-wide **tool catalog** (companion-tools.md §5) — the discovery
 * index `search_tools` reasons over, kept *off* the model's context. One
 * lightweight row per whitelisted tool (id, source, server, name, description);
 * deliberately **no argument schema**, so hundreds of tools cost no per-turn
 * tokens. Rebuilt from the whitelist by the catalog builder (catalog-builder.ts);
 * the authoritative schema is fetched fresh at `load_tool` time, never from here.
 */

import { type Database, toolCatalog } from '@cobble/db';
import type { ToolCatalogEntry } from '@cobble/shared';
import { eq, notInArray, sql } from 'drizzle-orm';

export type { ToolCatalogEntry };

export interface ToolCatalogStore {
  /** Insert or replace catalog entries (idempotent per `toolId`). */
  upsert(entries: readonly ToolCatalogEntry[]): Promise<void>;
  /** Drop every entry whose `toolId` is not in the given set (empty → clear all). */
  deleteNotIn(toolIds: readonly string[]): Promise<void>;
  /** Every catalog entry — the full menu `search_tools` searches. */
  list(): Promise<readonly ToolCatalogEntry[]>;
  /** One entry by id, or null when it isn't in the catalog (= not whitelisted). */
  get(toolId: string): Promise<ToolCatalogEntry | null>;
}

/** Postgres-backed catalog (the `tool_catalog` table). */
export class DrizzleToolCatalogStore implements ToolCatalogStore {
  constructor(private readonly db: Database) {}

  async upsert(entries: readonly ToolCatalogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.db
      .insert(toolCatalog)
      .values(
        entries.map((entry) => ({
          toolId: entry.toolId,
          source: entry.source,
          serverRef: entry.serverRef,
          toolName: entry.toolName,
          description: entry.description,
        })),
      )
      .onConflictDoUpdate({
        target: toolCatalog.toolId,
        set: {
          source: sqlExcluded('source'),
          serverRef: sqlExcluded('server_ref'),
          toolName: sqlExcluded('tool_name'),
          description: sqlExcluded('description'),
        },
      });
  }

  async deleteNotIn(toolIds: readonly string[]): Promise<void> {
    if (toolIds.length === 0) {
      // notInArray([]) is a footgun (degenerate SQL) — an empty keep-set means
      // "clear the catalog", so delete unconditionally.
      await this.db.delete(toolCatalog);
      return;
    }
    await this.db.delete(toolCatalog).where(notInArray(toolCatalog.toolId, [...toolIds]));
  }

  async list(): Promise<readonly ToolCatalogEntry[]> {
    const rows = await this.db.select().from(toolCatalog);
    return rows.map(toEntry);
  }

  async get(toolId: string): Promise<ToolCatalogEntry | null> {
    const [row] = await this.db
      .select()
      .from(toolCatalog)
      .where(eq(toolCatalog.toolId, toolId))
      .limit(1);
    return row ? toEntry(row) : null;
  }
}

/** `excluded.<col>` reference for an upsert's update clause (the incoming row). */
function sqlExcluded(column: string): ReturnType<typeof sql> {
  return sql.raw(`excluded.${column}`);
}

function toEntry(row: typeof toolCatalog.$inferSelect): ToolCatalogEntry {
  return {
    toolId: row.toolId,
    source: row.source,
    serverRef: row.serverRef,
    toolName: row.toolName,
    description: row.description,
  };
}
