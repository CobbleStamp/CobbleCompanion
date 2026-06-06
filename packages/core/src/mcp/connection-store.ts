/**
 * The per-companion MCP connection registry (companion-tools.md §4) — the live
 * wiring of which whitelisted servers a companion has connected to, plus the last
 * `tools/list` snapshot so the registry rebuilds at turn time without a network
 * round-trip. This module owns the contract; the Drizzle implementation and the
 * `mcp_connections` table live alongside it (slice 3). Secrets are never stored —
 * auth is resolved from the whitelist's env reference at connect time (§7).
 */

import type { McpToolDef } from './gateway.js';

export type McpConnectionStatus = 'connected' | 'error';

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
