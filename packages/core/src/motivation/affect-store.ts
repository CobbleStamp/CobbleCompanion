/**
 * Affect store (Phase 4.2, companion-motivation.md §7) — the durable rolling read
 * of the user's mood, one row per companion. The harness reads the prior reading
 * at the start of a turn (to attune the reply) and upserts the fresh reading at
 * the end (so the next turn can measure the *change*). Last-write-wins: there is
 * no cursor — it is a single rolling value, not a catch-up pass.
 */

import { companionAffect, type Database } from '@cobble/db';
import { eq } from 'drizzle-orm';
import type { AffectReading } from './affect.js';

export interface CompanionAffectStore {
  /** The companion's last stored read of the user, or null if none yet. */
  get(companionId: string): Promise<AffectReading | null>;
  /** Replace the stored read with `reading` (last-write-wins). No version guard:
   *  this is safe because the harness serializes the read→sense→upsert per
   *  companion (chainAffect), so writes for one companion never overlap. A second
   *  process writing the same companion would reintroduce a clobber — out of scope
   *  for the single-instance PoC. See harness.ts `perceiveAndLearn`. */
  upsert(companionId: string, reading: AffectReading): Promise<void>;
}

export class DrizzleCompanionAffectStore implements CompanionAffectStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(companionId: string): Promise<AffectReading | null> {
    const [row] = await this.db
      .select()
      .from(companionAffect)
      .where(eq(companionAffect.companionId, companionId))
      .limit(1);
    return row ? { valence: row.valence, note: row.note } : null;
  }

  async upsert(companionId: string, reading: AffectReading): Promise<void> {
    await this.db
      .insert(companionAffect)
      .values({
        companionId,
        valence: reading.valence,
        note: reading.note,
        updatedAt: this.now(),
      })
      .onConflictDoUpdate({
        target: companionAffect.companionId,
        set: { valence: reading.valence, note: reading.note, updatedAt: this.now() },
      });
  }
}
