/**
 * The lead inventory store (Phase 3) — the companion's reading list of
 * discovered-but-unread URLs. `record` is idempotent on `(companionId, url)` so
 * re-spotting a link never duplicates it. The Phase 4 motivation engine will pull
 * from here on idle; Phase 3 fills it (web_fetch link harvest) and works it on
 * the user's command.
 */

import { leads, type Database } from '@cobble/db';
import type { LeadStatus } from '@cobble/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

export interface LeadRecord {
  readonly id: string;
  readonly url: string;
  readonly why: string | null;
  readonly status: LeadStatus;
  readonly createdAt: Date;
}

export interface LeadStore {
  /** Capture a lead; a no-op if this companion already has this URL (idempotent). */
  record(companionId: string, url: string, why?: string): Promise<void>;
  /** Leads in the given statuses, oldest first (the reading-list order). */
  listByStatus(
    companionId: string,
    statuses: readonly LeadStatus[],
  ): Promise<readonly LeadRecord[]>;
  /** Advance a lead's lifecycle (new→read→ingested/discarded). */
  markStatus(companionId: string, leadId: string, status: LeadStatus): Promise<void>;
  /**
   * Distinct companions with at least one `new` lead — the Phase 4 motivation
   * sweep's worklist (a companion worth a tick because there's something to
   * explore). Cheap scan; the engine's gate still decides whether to act.
   */
  companionsWithNewLeads(): Promise<readonly string[]>;
}

export class DrizzleLeadStore implements LeadStore {
  constructor(private readonly db: Database) {}

  async record(companionId: string, url: string, why?: string): Promise<void> {
    await this.db
      .insert(leads)
      .values({ companionId, url, ...(why !== undefined ? { why } : {}) })
      .onConflictDoNothing({ target: [leads.companionId, leads.url] });
  }

  async listByStatus(
    companionId: string,
    statuses: readonly LeadStatus[],
  ): Promise<readonly LeadRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.companionId, companionId), inArray(leads.status, [...statuses])))
      .orderBy(asc(leads.seq));
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      why: row.why,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  async markStatus(companionId: string, leadId: string, status: LeadStatus): Promise<void> {
    await this.db
      .update(leads)
      .set({ status })
      .where(and(eq(leads.id, leadId), eq(leads.companionId, companionId)));
  }

  async companionsWithNewLeads(): Promise<readonly string[]> {
    const rows = await this.db
      .selectDistinct({ companionId: leads.companionId })
      .from(leads)
      .where(eq(leads.status, 'new'));
    return rows.map((row) => row.companionId);
  }
}
