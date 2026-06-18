/**
 * Two-part-upload staging (deliver-scalability.md §6 D-A). An intake route stores
 * an upload's raw bytes here, then enqueues an `ingest` job that references the
 * staged row — so the job can run on ANY node (the old in-memory IngestionRunner
 * queue could not survive a cross-node claim). The consuming job deletes the row
 * once the pipeline has read it; `purgeExpired` is the GC backstop for bytes that
 * were staged but never enqueued.
 */

import { uploadStaging, type Database } from '@cobble/db';
import type { SourceKind } from '@cobble/shared';
import { eq, lt, sql } from 'drizzle-orm';

/** A staged upload, as the `ingest` job reads it back. */
export interface StagedUpload {
  readonly id: string;
  readonly kind: SourceKind;
  readonly bytes: Uint8Array;
}

export interface StageUploadParams {
  readonly ownerId: string;
  readonly kind: SourceKind;
  readonly bytes: Uint8Array;
}

/** The durable home for an upload's bytes between accept and ingest. */
export interface UploadStagingStore {
  stage(params: StageUploadParams): Promise<{ id: string }>;
  get(id: string): Promise<StagedUpload | null>;
  delete(id: string): Promise<void>;
  /** Drop staged uploads past their TTL that were never consumed. Returns the count. */
  purgeExpired(): Promise<number>;
}

/** Default TTL: an upload is normally consumed in seconds; this is a leak backstop. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class DrizzleUploadStagingStore implements UploadStagingStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async stage(params: StageUploadParams): Promise<{ id: string }> {
    const rows = await this.db
      .insert(uploadStaging)
      .values({
        ownerId: params.ownerId,
        kind: params.kind,
        bytes: params.bytes,
        byteSize: params.bytes.length,
        expiresAt: sql`now() + ${this.ttlMs} * interval '1 millisecond'`,
      })
      .returning({ id: uploadStaging.id });
    return { id: rows[0]!.id };
  }

  async get(id: string): Promise<StagedUpload | null> {
    const rows = await this.db
      .select({ id: uploadStaging.id, kind: uploadStaging.kind, bytes: uploadStaging.bytes })
      .from(uploadStaging)
      .where(eq(uploadStaging.id, id))
      .limit(1);
    const row = rows[0];
    return row ? { id: row.id, kind: row.kind, bytes: row.bytes } : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(uploadStaging).where(eq(uploadStaging.id, id));
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(uploadStaging)
      .where(lt(uploadStaging.expiresAt, sql`now()`))
      .returning({ id: uploadStaging.id });
    return rows.length;
  }
}
