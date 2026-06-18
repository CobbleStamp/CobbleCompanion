/** S3UploadStagingStore against an in-memory fake of the S3 surface
 *  (staging-object-storage.md §4.1): slot presigning, server-side stage, ranged
 *  peek, head, get/delete, and the purgeExpired no-op. */

import { describe, expect, it } from 'vitest';
import { parseUploadKey } from './upload-staging.js';
import { S3UploadStagingStore, type S3Operations } from './upload-staging-s3.js';

/** In-memory S3: a key→bytes map plus a presign that just encodes the key. */
function fakeS3(): S3Operations & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async presignPut(key, opts) {
      return `https://s3.example/${encodeURIComponent(key)}?exp=${opts.expiresInSec}`;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { byteSize: bytes.byteLength } : null;
    },
    async getRange(key, n) {
      const bytes = objects.get(key);
      return bytes ? bytes.slice(0, n) : null;
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const config = { bucket: 'cc-uploads', prefix: 'tmp-uploads', ttlMs: 3_600_000 };

describe('S3UploadStagingStore', () => {
  it('issues a presigned PUT slot carrying the owner+kind key', async () => {
    const store = new S3UploadStagingStore(fakeS3(), config);
    const slot = await store.createUploadSlot({
      ownerId: 'owner-1',
      kind: 'pdf',
      contentType: 'application/pdf',
      maxBytes: 1024,
    });

    expect(slot.method).toBe('PUT');
    expect(slot.url).toContain('https://s3.example/');
    expect(slot.url).toContain('exp=3600');
    expect(slot.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(parseUploadKey('tmp-uploads', slot.uploadId)).toEqual({
      ownerId: 'owner-1',
      kind: 'pdf',
    });
  });

  it('stages bytes server-side and reads them back with the key kind', async () => {
    const s3 = fakeS3();
    const store = new S3UploadStagingStore(s3, config);
    const bytes = new TextEncoder().encode('a note body');

    const { id } = await store.stage({ ownerId: 'owner-1', kind: 'note', bytes });
    expect(s3.objects.has(id)).toBe(true);

    const staged = await store.get(id);
    expect(staged?.kind).toBe('note');
    expect(staged ? new TextDecoder().decode(staged.bytes) : null).toBe('a note body');
  });

  it('head and ranged peek read only what they need', async () => {
    const s3 = fakeS3();
    const store = new S3UploadStagingStore(s3, config);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 9, 9]);
    const { id } = await store.stage({ ownerId: 'o', kind: 'pdf', bytes });

    expect(await store.head(id)).toEqual({ byteSize: 8 });
    expect(await store.peek(id, 5)).toEqual(bytes.slice(0, 5));
  });

  it('returns null for an absent or unparseable key', async () => {
    const store = new S3UploadStagingStore(fakeS3(), config);
    expect(await store.get('tmp-uploads/o/missing__pdf')).toBeNull();
    expect(await store.head('tmp-uploads/o/missing__pdf')).toBeNull();
    expect(await store.get('not-a-valid-key')).toBeNull();
  });

  it('delete removes the object; purgeExpired is a no-op (lifecycle owns TTL)', async () => {
    const s3 = fakeS3();
    const store = new S3UploadStagingStore(s3, config);
    const { id } = await store.stage({ ownerId: 'o', kind: 'md', bytes: new Uint8Array([1]) });

    await store.delete(id);
    expect(s3.objects.has(id)).toBe(false);
    expect(await store.purgeExpired()).toBe(0);
  });
});
