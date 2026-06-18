/**
 * Upload staging (staging-object-storage.md). An upload's raw bytes live in
 * object storage (S3 in production) or a local filesystem root (dev/CI), never in
 * Postgres — the `ingest` job reads them back on ANY node by their `uploadId`,
 * which is the object key itself. Two ways bytes arrive:
 *
 *   - `createUploadSlot` — a presigned/direct slot for browser FILE uploads: the
 *     client PUTs straight to the backend, bypassing the API.
 *   - `stage` — a server-side write for small in-hand payloads the API already
 *     holds (note/link sources, the `ingest_source` tool).
 *
 * The key encodes the owner (for authorization at enqueue) and the kind (so `get`
 * can reconstruct the payload) — there is no staging metadata table. Expiry is the
 * backend's job: an S3 bucket lifecycle rule on the prefix, or `purgeExpired` for
 * the filesystem backend.
 */

import { randomUUID } from 'node:crypto';
import type { SourceKind } from '@cobble/shared';

/** A staged upload, as the `ingest` job reads it back. */
export interface StagedUpload {
  readonly id: string;
  readonly kind: SourceKind;
  readonly bytes: Uint8Array;
}

/** A server-side write of bytes the API already holds (note/link, tool). */
export interface StageUploadParams {
  readonly ownerId: string;
  readonly kind: SourceKind;
  readonly bytes: Uint8Array;
}

/** Parameters for issuing a direct-upload slot for a browser file upload. */
export interface CreateUploadSlotParams {
  readonly ownerId: string;
  readonly kind: SourceKind;
  /** Pinned on the slot so the stored object's content type is fixed. */
  readonly contentType?: string;
  /** Upper bound the backend may enforce on the uploaded body. */
  readonly maxBytes: number;
}

/** A capability the client uses to upload bytes directly to the backend. */
export interface UploadSlot {
  /** Opaque id == the object key; carries owner + kind (see {@link parseUploadKey}). */
  readonly uploadId: string;
  /** Absolute URL the client PUTs the body to. */
  readonly url: string;
  readonly method: 'PUT';
  /** Headers the client must send on the PUT (e.g. content-type). */
  readonly headers?: Readonly<Record<string, string>>;
  /** ISO-8601 instant after which the slot/object is no longer valid. */
  readonly expiresAt: string;
}

/** The durable home for an upload's bytes between accept and ingest. */
export interface UploadStagingStore {
  /** Issue a direct-upload slot for a client file upload. */
  createUploadSlot(params: CreateUploadSlotParams): Promise<UploadSlot>;
  /** Server-side write for small in-hand payloads. Returns the new upload id. */
  stage(params: StageUploadParams): Promise<{ id: string }>;
  /** Size of a staged object without downloading the body; null if absent. */
  head(id: string): Promise<{ byteSize: number } | null>;
  /** First `n` bytes only (ranged) — for magic-byte validation; null if absent. */
  peek(id: string, n: number): Promise<Uint8Array | null>;
  /** Full read of a staged object; null if absent. */
  get(id: string): Promise<StagedUpload | null>;
  /** Remove a staged object. Idempotent — absent is success. */
  delete(id: string): Promise<void>;
  /**
   * Drop staged objects past their TTL that were never consumed; returns the
   * count. The filesystem backend sweeps files; S3 returns 0 because the bucket
   * lifecycle rule on the prefix owns expiry server-side.
   */
  purgeExpired(): Promise<number>;
}

/** The slice the `ingest` job consumes — read the bytes, then drop them. */
export type StagedUploadConsumer = Pick<UploadStagingStore, 'get' | 'delete'>;

/** All `SourceKind`s, for validating a kind parsed out of an untrusted key. */
const SOURCE_KINDS: readonly SourceKind[] = ['pdf', 'note', 'link', 'txt', 'md', 'docx', 'pptx'];

/** Separates the random id from the kind suffix in a key's last segment. */
const KIND_SEP = '__';

/** The owner + kind decoded from a staging key. */
export interface ParsedUploadKey {
  readonly ownerId: string;
  readonly kind: SourceKind;
}

/**
 * Build a staging key: `<prefix>/<ownerId>/<uuid>__<kind>`. The owner prefix is
 * what the enqueue step authorizes against; the kind suffix is what `get` reads
 * back. `ownerId` must not contain a slash (ULIDs/UUIDs do not).
 */
export function buildUploadKey(prefix: string, ownerId: string, kind: SourceKind): string {
  return `${prefix}/${ownerId}/${randomUUID()}${KIND_SEP}${kind}`;
}

/**
 * Decode a staging key, validating its structure and that the kind is real.
 * Returns null for anything that does not match the exact layout — so a forged or
 * malformed `uploadId` is rejected rather than trusted.
 */
export function parseUploadKey(prefix: string, key: string): ParsedUploadKey | null {
  const parts = key.split('/');
  if (parts.length !== 3) {
    return null;
  }
  const [keyPrefix, ownerId, last] = parts;
  if (keyPrefix !== prefix || !ownerId || !last) {
    return null;
  }
  const sep = last.lastIndexOf(KIND_SEP);
  if (sep <= 0) {
    return null;
  }
  const kind = last.slice(sep + KIND_SEP.length);
  if (!SOURCE_KINDS.includes(kind as SourceKind)) {
    return null;
  }
  return { ownerId, kind: kind as SourceKind };
}
