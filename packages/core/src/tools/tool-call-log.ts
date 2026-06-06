/**
 * The tool-call audit log (Phase 3 DoD: "every tool call is logged"). Append-only
 * record of each executed tool call — read-only and approved-effectful alike —
 * with its name, args, and result content. Used by the harness `afterToolCall`
 * hook so logging is uniform across every dispatch.
 */

import { toolCalls, type Database } from '@cobble/db';
import { count, desc, eq } from 'drizzle-orm';

export interface ToolCallRecord {
  readonly id: string;
  readonly companionId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly createdAt: Date;
}

/** Distinct tools used + total calls — the substrate behind tool-fluency abilities (P5). */
export interface ToolCallStats {
  readonly distinctNames: readonly string[];
  readonly total: number;
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
  /**
   * Aggregate tool-use shape for the Phase 5 abilities axis: the distinct tool
   * names the companion has run and the total number of calls. Derived from the
   * audit log, so abilities reflect what it has actually done.
   */
  stats(companionId: string): Promise<ToolCallStats>;
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

  async stats(companionId: string): Promise<ToolCallStats> {
    const names = await this.db
      .selectDistinct({ name: toolCalls.name })
      .from(toolCalls)
      .where(eq(toolCalls.companionId, companionId));
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(toolCalls)
      .where(eq(toolCalls.companionId, companionId));
    return {
      distinctNames: names.map((row) => row.name),
      total: totalRow?.value ?? 0,
    };
  }
}
