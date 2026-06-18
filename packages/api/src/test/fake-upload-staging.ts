/**
 * In-memory {@link UploadStagingStore} for API tests — no S3, no filesystem. It
 * mirrors the real key layout (so `parseUploadKey` authorization works) and lets a
 * test seed bytes at a slot's key to simulate the client's direct upload.
 */

import {
  buildUploadKey,
  parseUploadKey,
  type CreateUploadSlotParams,
  type StageUploadParams,
  type StagedUpload,
  type UploadSlot,
  type UploadStagingStore,
} from '@cobble/core';
import type { SourceKind } from '@cobble/shared';

export class InMemoryUploadStagingStore implements UploadStagingStore {
  readonly objects = new Map<string, { kind: SourceKind; bytes: Uint8Array }>();

  constructor(
    private readonly prefix: string = 'tmp-uploads',
    private readonly ttlMs: number = 60 * 60 * 1000,
    private readonly publicBaseUrl: string = 'http://localhost:3000',
  ) {}

  async createUploadSlot(params: CreateUploadSlotParams): Promise<UploadSlot> {
    const uploadId = buildUploadKey(this.prefix, params.ownerId, params.kind);
    return {
      uploadId,
      url: `${this.publicBaseUrl}/uploads/local/${encodeURIComponent(uploadId)}`,
      method: 'PUT',
      ...(params.contentType ? { headers: { 'content-type': params.contentType } } : {}),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
  }

  async stage(params: StageUploadParams): Promise<{ id: string }> {
    const id = buildUploadKey(this.prefix, params.ownerId, params.kind);
    this.objects.set(id, { kind: params.kind, bytes: params.bytes });
    return { id };
  }

  /** Test helper: simulate the client having uploaded bytes at a slot's key. */
  put(id: string, bytes: Uint8Array): void {
    const parsed = parseUploadKey(this.prefix, id);
    if (!parsed) {
      throw new Error('cannot seed an unparseable staging key');
    }
    this.objects.set(id, { kind: parsed.kind, bytes });
  }

  async head(id: string): Promise<{ byteSize: number } | null> {
    const object = this.objects.get(id);
    return object ? { byteSize: object.bytes.byteLength } : null;
  }

  async peek(id: string, n: number): Promise<Uint8Array | null> {
    const object = this.objects.get(id);
    return object ? object.bytes.slice(0, n) : null;
  }

  async get(id: string): Promise<StagedUpload | null> {
    const object = this.objects.get(id);
    return object ? { id, kind: object.kind, bytes: object.bytes } : null;
  }

  async delete(id: string): Promise<void> {
    this.objects.delete(id);
  }

  async purgeExpired(): Promise<number> {
    return 0;
  }
}
