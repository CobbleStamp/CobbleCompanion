/**
 * Procedural memory store (Phase 3 seed) — records a learned, reusable workflow
 * after a successful action (the ordered tool steps it ran). Browsable; retrieval
 * as a hint into context is deferred to the growth system (Phase 5).
 */

import { proceduralMemories, type Database } from '@cobble/db';
import { desc, eq } from 'drizzle-orm';

export interface ProcedureRecord {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly createdAt: Date;
}

export interface ProceduralStore {
  /** Record a completed workflow (title + the ordered tool steps it ran). */
  record(companionId: string, title: string, steps: readonly string[]): Promise<void>;
  /** The companion's procedures, newest first. */
  list(companionId: string, limit: number): Promise<readonly ProcedureRecord[]>;
  /** How many procedures the companion has learned. */
  count(companionId: string): Promise<number>;
}

export class DrizzleProceduralStore implements ProceduralStore {
  constructor(private readonly db: Database) {}

  async record(companionId: string, title: string, steps: readonly string[]): Promise<void> {
    await this.db.insert(proceduralMemories).values({ companionId, title, steps: [...steps] });
  }

  async list(companionId: string, limit: number): Promise<readonly ProcedureRecord[]> {
    const rows = await this.db
      .select()
      .from(proceduralMemories)
      .where(eq(proceduralMemories.companionId, companionId))
      .orderBy(desc(proceduralMemories.seq))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      steps: (row.steps ?? []) as string[],
      createdAt: row.createdAt,
    }));
  }

  async count(companionId: string): Promise<number> {
    const rows = await this.db
      .select({ id: proceduralMemories.id })
      .from(proceduralMemories)
      .where(eq(proceduralMemories.companionId, companionId));
    return rows.length;
  }
}
