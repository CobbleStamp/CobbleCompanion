import { and, desc, eq } from 'drizzle-orm';
import { missionJournal, missions, type Database } from '@cobble/db';
import type { MissionStatus } from '@cobble/shared';

/**
 * Data access for `missions` + `mission_journal` (companion-missions.md §3.4). Lives in
 * `@cobble/core` alongside the other domain stores (leads, proposals, memory), importing the
 * table definitions from `@cobble/db`. The mission concept, planner, and advance loop live in
 * core; this module owns only durable persistence and the atomic lifecycle transitions.
 *
 * "One active mission per companion" is enforced at the DB level by a partial unique index
 * (`missions_one_active_per_companion_uniq`); {@link MissionStore.activate} relies on it as
 * the backstop and callers guard with {@link MissionStore.hasActive} first.
 */

export interface MissionRecord {
  readonly id: string;
  readonly companionId: string;
  readonly goal: string;
  /** The planner's decomposition; null while still `draft`. */
  readonly plan: string | null;
  readonly validationCriteria: string | null;
  readonly status: MissionStatus;
  readonly jobIds: readonly string[];
  readonly reportChannel: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The planner output applied when a draft mission is approved and goes `active`. */
export interface MissionActivation {
  readonly plan: string;
  readonly validationCriteria: string;
  readonly jobIds: readonly string[];
  readonly reportChannel: string;
}

/** One appended mission-turn outcome (all content fields optional). */
export interface MissionJournalInput {
  readonly event?: string | null;
  readonly findings?: string | null;
  readonly prediction?: string | null;
  readonly decision?: string | null;
}

export interface MissionJournalRecord {
  readonly id: string;
  readonly missionId: string;
  readonly event: string | null;
  readonly findings: string | null;
  readonly prediction: string | null;
  readonly decision: string | null;
  readonly turnAt: Date;
}

interface MissionRow {
  readonly id: string;
  readonly companionId: string;
  readonly goal: string;
  readonly plan: string | null;
  readonly validationCriteria: string | null;
  readonly status: MissionStatus;
  readonly jobIds: readonly string[];
  readonly reportChannel: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MissionJournalRow {
  readonly id: string;
  readonly missionId: string;
  readonly event: string | null;
  readonly findings: string | null;
  readonly prediction: string | null;
  readonly decision: string | null;
  readonly turnAt: Date;
}

// `outward_grant` (schema.ts) is intentionally NOT surfaced on the record — it is
// deferred (companion-missions.md §4); when a future effectful-tool mission wires it up,
// MissionRow, MissionRecord, and this mapper each gain the field together.
function toMissionRecord(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    companionId: row.companionId,
    goal: row.goal,
    plan: row.plan,
    validationCriteria: row.validationCriteria,
    status: row.status,
    jobIds: row.jobIds,
    reportChannel: row.reportChannel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toJournalRecord(row: MissionJournalRow): MissionJournalRecord {
  return {
    id: row.id,
    missionId: row.missionId,
    event: row.event,
    findings: row.findings,
    prediction: row.prediction,
    decision: row.decision,
    turnAt: row.turnAt,
  };
}

export interface MissionStore {
  /** Create a `draft` mission from an assigned goal (the planner fills the rest). */
  create(companionId: string, goal: string): Promise<MissionRecord>;
  findById(id: string): Promise<MissionRecord | null>;
  /** The companion's single `active` mission (the trigger-routing target), or null. */
  findActive(companionId: string): Promise<MissionRecord | null>;
  /** Cheap existence check for the drive-suspension gate (companion-missions.md §3.4). */
  hasActive(companionId: string): Promise<boolean>;
  listByCompanion(companionId: string): Promise<MissionRecord[]>;
  /**
   * Approve + activate a `draft` mission: apply the plan and go `active`. Guarded to the
   * `draft` state, so a double-approve is a no-op (returns null). May reject at the DB if
   * another mission is already `active` for the companion (the partial unique index) —
   * callers guard with {@link hasActive} first.
   */
  activate(id: string, input: MissionActivation): Promise<MissionRecord | null>;
  /** Move a mission to a new lifecycle status (pause/resume/stop/complete/fail). */
  setStatus(id: string, status: MissionStatus): Promise<MissionRecord | null>;
  /** Replace the registered scheduler job ids (on re-arm). */
  setJobIds(id: string, jobIds: readonly string[]): Promise<MissionRecord | null>;
}

export class DrizzleMissionStore implements MissionStore {
  constructor(private readonly db: Database) {}

  async create(companionId: string, goal: string): Promise<MissionRecord> {
    const [row] = await this.db.insert(missions).values({ companionId, goal }).returning();
    return toMissionRecord(row as MissionRow);
  }

  async findById(id: string): Promise<MissionRecord | null> {
    const [row] = await this.db.select().from(missions).where(eq(missions.id, id)).limit(1);
    return row ? toMissionRecord(row as MissionRow) : null;
  }

  async findActive(companionId: string): Promise<MissionRecord | null> {
    const [row] = await this.db
      .select()
      .from(missions)
      .where(and(eq(missions.companionId, companionId), eq(missions.status, 'active')))
      .limit(1);
    return row ? toMissionRecord(row as MissionRow) : null;
  }

  async hasActive(companionId: string): Promise<boolean> {
    return (await this.findActive(companionId)) !== null;
  }

  async listByCompanion(companionId: string): Promise<MissionRecord[]> {
    const rows = await this.db
      .select()
      .from(missions)
      .where(eq(missions.companionId, companionId))
      .orderBy(desc(missions.seq));
    return rows.map((row) => toMissionRecord(row as MissionRow));
  }

  async activate(id: string, input: MissionActivation): Promise<MissionRecord | null> {
    const [row] = await this.db
      .update(missions)
      .set({
        plan: input.plan,
        validationCriteria: input.validationCriteria,
        jobIds: input.jobIds,
        reportChannel: input.reportChannel,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(and(eq(missions.id, id), eq(missions.status, 'draft')))
      .returning();
    return row ? toMissionRecord(row as MissionRow) : null;
  }

  async setStatus(id: string, status: MissionStatus): Promise<MissionRecord | null> {
    const [row] = await this.db
      .update(missions)
      .set({ status, updatedAt: new Date() })
      .where(eq(missions.id, id))
      .returning();
    return row ? toMissionRecord(row as MissionRow) : null;
  }

  async setJobIds(id: string, jobIds: readonly string[]): Promise<MissionRecord | null> {
    const [row] = await this.db
      .update(missions)
      .set({ jobIds, updatedAt: new Date() })
      .where(eq(missions.id, id))
      .returning();
    return row ? toMissionRecord(row as MissionRow) : null;
  }
}

export interface MissionJournalStore {
  /** Append one turn outcome to a mission's journal. */
  append(missionId: string, input: MissionJournalInput): Promise<MissionJournalRecord>;
  /** The most-recent `limit` journal rows for a mission, newest first. */
  recent(missionId: string, limit: number): Promise<MissionJournalRecord[]>;
}

export class DrizzleMissionJournalStore implements MissionJournalStore {
  constructor(private readonly db: Database) {}

  async append(missionId: string, input: MissionJournalInput): Promise<MissionJournalRecord> {
    const [row] = await this.db
      .insert(missionJournal)
      .values({
        missionId,
        event: input.event ?? null,
        findings: input.findings ?? null,
        prediction: input.prediction ?? null,
        decision: input.decision ?? null,
      })
      .returning();
    return toJournalRecord(row as MissionJournalRow);
  }

  async recent(missionId: string, limit: number): Promise<MissionJournalRecord[]> {
    const rows = await this.db
      .select()
      .from(missionJournal)
      .where(eq(missionJournal.missionId, missionId))
      .orderBy(desc(missionJournal.seq))
      .limit(limit);
    return rows.map((row) => toJournalRecord(row as MissionJournalRow));
  }
}
