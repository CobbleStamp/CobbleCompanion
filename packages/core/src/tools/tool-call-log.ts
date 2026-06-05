/**
 * The tool-call audit log (Phase 3 DoD: "every tool call is logged"). Append-only
 * record of each executed tool call — read-only and approved-effectful alike —
 * with its name, args, and result content. Used by the harness `afterToolCall`
 * hook so logging is uniform across every dispatch.
 */

import { toolCalls, type Database } from '@cobble/db';
import { desc, eq } from 'drizzle-orm';

export interface ToolCallRecord {
  readonly id: string;
  readonly companionId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly createdAt: Date;
}

export interface ToolCallLog {
  /** Append one executed tool call. Best-effort callers may ignore the result. */
  record(
    companionId: string,
    name: string,
    args: Record<string, unknown>,
    result: string,
  ): Promise<void>;
  /** The companion's recent tool calls, newest first (audit/browse). */
  list(companionId: string, limit: number): Promise<readonly ToolCallRecord[]>;
}

export class DrizzleToolCallLog implements ToolCallLog {
  constructor(private readonly db: Database) {}

  async record(
    companionId: string,
    name: string,
    args: Record<string, unknown>,
    result: string,
  ): Promise<void> {
    await this.db.insert(toolCalls).values({ companionId, name, args, result });
  }

  async list(companionId: string, limit: number): Promise<readonly ToolCallRecord[]> {
    const rows = await this.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.companionId, companionId))
      .orderBy(desc(toolCalls.seq))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      companionId: row.companionId,
      name: row.name,
      args: (row.args ?? {}) as Record<string, unknown>,
      result: row.result,
      createdAt: row.createdAt,
    }));
  }
}
