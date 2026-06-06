/**
 * The per-companion MCP connection registry (companion-tools.md §4) — the live
 * wiring of which whitelisted servers a companion has connected to, plus the last
 * `tools/list` snapshot so the registry rebuilds at turn time without a network
 * round-trip. Secrets are never stored — auth is resolved from the whitelist's env
 * reference at connect time (§7). One row per (companion, server_ref); connecting
 * again replaces it.
 */

import { type Database, mcpConnections } from '@cobble/db';
import type { McpConnectionStatus } from '@cobble/shared';
import { and, eq } from 'drizzle-orm';
import type { McpToolDef } from './gateway.js';

export type { McpConnectionStatus };

export interface McpConnectionRecord {
  readonly id: string;
  readonly companionId: string;
  readonly serverRef: string;
  /** The server's tools as of the last successful connect — drives registry rebuild. */
  readonly toolsSnapshot: readonly McpToolDef[];
  readonly status: McpConnectionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertConnectionInput {
  readonly serverRef: string;
  readonly toolsSnapshot: readonly McpToolDef[];
  readonly status: McpConnectionStatus;
}

export interface McpConnectionStore {
  /** Create or replace a companion's connection to a server (idempotent per ref). */
  upsert(companionId: string, input: UpsertConnectionInput): Promise<McpConnectionRecord>;
  /** A companion's connections, used to rebuild its tool registry at turn time. */
  list(companionId: string): Promise<readonly McpConnectionRecord[]>;
  /** One connection by server ref, or null when not connected. */
  get(companionId: string, serverRef: string): Promise<McpConnectionRecord | null>;
}

/** Postgres-backed connection registry (the `mcp_connections` table). */
export class DrizzleMcpConnectionStore implements McpConnectionStore {
  constructor(private readonly db: Database) {}

  async upsert(companionId: string, input: UpsertConnectionInput): Promise<McpConnectionRecord> {
    const [row] = await this.db
      .insert(mcpConnections)
      .values({
        companionId,
        serverRef: input.serverRef,
        toolsSnapshot: input.toolsSnapshot,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [mcpConnections.companionId, mcpConnections.serverRef],
        set: { toolsSnapshot: input.toolsSnapshot, status: input.status, updatedAt: new Date() },
      })
      .returning();
    if (!row) {
      throw new Error('failed to upsert mcp connection');
    }
    return toRecord(row);
  }

  async list(companionId: string): Promise<readonly McpConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.companionId, companionId));
    return rows.map(toRecord);
  }

  async get(companionId: string, serverRef: string): Promise<McpConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(mcpConnections)
      .where(
        and(eq(mcpConnections.companionId, companionId), eq(mcpConnections.serverRef, serverRef)),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: typeof mcpConnections.$inferSelect): McpConnectionRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    serverRef: row.serverRef,
    toolsSnapshot: row.toolsSnapshot,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
