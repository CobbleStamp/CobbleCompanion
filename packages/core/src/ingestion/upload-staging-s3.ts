/**
 * S3-backed upload staging for production (staging-object-storage.md §4.1). The
 * store itself is SDK-free: it speaks to a narrow {@link S3Operations} port so it
 * stays unit-testable with an in-memory fake, and the real `@aws-sdk` adapter
 * lives in `upload-staging-s3-aws.ts`. File uploads go straight to S3 via a
 * presigned PUT (`createUploadSlot`); `purgeExpired` is a no-op because the bucket
 * lifecycle rule on the prefix owns expiry.
 */

import {
  buildUploadKey,
  parseUploadKey,
  type CreateUploadSlotParams,
  type StageUploadParams,
  type StagedUpload,
  type UploadSlot,
  type UploadStagingStore,
} from './upload-staging.js';

/** The S3 surface the store needs; the AWS adapter implements it. */
export interface S3Operations {
  /** A presigned PUT URL the client uploads the body to. */
  presignPut(
    key: string,
    opts: { readonly contentType?: string; readonly expiresInSec: number },
  ): Promise<string>;
  /** Server-side upload of bytes we already hold. */
  put(key: string, bytes: Uint8Array, opts?: { readonly contentType?: string }): Promise<void>;
  /** Object size without the body; null if absent. */
  head(key: string): Promise<{ byteSize: number } | null>;
  /** First `n` bytes (ranged GET); null if absent. */
  getRange(key: string, n: number): Promise<Uint8Array | null>;
  /** Full object body; null if absent. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete; idempotent. */
  delete(key: string): Promise<void>;
}

export interface S3StagingConfig {
  readonly bucket: string;
  readonly prefix: string;
  /** Slot lifetime; mirrors the bucket lifecycle expiry so a slot can't outlive the object. */
  readonly ttlMs: number;
}

export class S3UploadStagingStore implements UploadStagingStore {
  constructor(
    private readonly s3: S3Operations,
    private readonly config: S3StagingConfig,
  ) {}

  async createUploadSlot(params: CreateUploadSlotParams): Promise<UploadSlot> {
    const uploadId = buildUploadKey(this.config.prefix, params.ownerId, params.kind);
    const url = await this.s3.presignPut(uploadId, {
      ...(params.contentType ? { contentType: params.contentType } : {}),
      expiresInSec: Math.ceil(this.config.ttlMs / 1000),
    });
    return {
      uploadId,
      url,
      method: 'PUT',
      ...(params.contentType ? { headers: { 'content-type': params.contentType } } : {}),
      expiresAt: new Date(Date.now() + this.config.ttlMs).toISOString(),
    };
  }

  async stage(params: StageUploadParams): Promise<{ id: string }> {
    const id = buildUploadKey(this.config.prefix, params.ownerId, params.kind);
    await this.s3.put(id, params.bytes);
    return { id };
  }

  async head(id: string): Promise<{ byteSize: number } | null> {
    return this.s3.head(id);
  }

  async peek(id: string, n: number): Promise<Uint8Array | null> {
    if (n <= 0) {
      return new Uint8Array(0);
    }
    return this.s3.getRange(id, n);
  }

  async get(id: string): Promise<StagedUpload | null> {
    const parsed = parseUploadKey(this.config.prefix, id);
    if (!parsed) {
      return null;
    }
    const bytes = await this.s3.get(id);
    return bytes ? { id, kind: parsed.kind, bytes } : null;
  }

  async delete(id: string): Promise<void> {
    await this.s3.delete(id);
  }

  /** No-op: the bucket lifecycle rule on the prefix reclaims expired objects. */
  async purgeExpired(): Promise<number> {
    return 0;
  }
}
