/** FilesystemUploadStagingStore against a real temp dir (staging-object-storage.md
 *  §4.1): stage/get/head/peek/delete/purgeExpired, slot URLs, path safety. */

import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemUploadStagingStore } from './upload-staging-fs.js';
import { parseUploadKey } from './upload-staging.js';

describe('FilesystemUploadStagingStore', () => {
  let root: string;
  let store: FilesystemUploadStagingStore;
  const prefix = 'tmp-uploads';
  const ttlMs = 60_000;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-staging-'));
    store = new FilesystemUploadStagingStore({
      root,
      prefix,
      ttlMs,
      publicBaseUrl: 'https://api.example/',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stages bytes and reads them back with the kind from the key', async () => {
    const bytes = new TextEncoder().encode('hello world');
    const { id } = await store.stage({ ownerId: 'owner-1', kind: 'txt', bytes });

    const staged = await store.get(id);
    expect(staged?.kind).toBe('txt');
    expect(staged ? new TextDecoder().decode(staged.bytes) : null).toBe('hello world');
  });

  it('head reports size; peek returns only the requested prefix', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 1, 2, 3, 4]);
    const { id } = await store.stage({ ownerId: 'owner-1', kind: 'pdf', bytes });

    expect(await store.head(id)).toEqual({ byteSize: 10 });
    expect(await store.peek(id, 5)).toEqual(bytes.slice(0, 5));
  });

  it('returns null for absent objects across head/peek/get', async () => {
    const id = `${prefix}/owner-1/missing__pdf`;
    expect(await store.head(id)).toBeNull();
    expect(await store.peek(id, 4)).toBeNull();
    expect(await store.get(id)).toBeNull();
  });

  it('delete is idempotent', async () => {
    const { id } = await store.stage({
      ownerId: 'owner-1',
      kind: 'md',
      bytes: new Uint8Array([1]),
    });
    await store.delete(id);
    await expect(store.delete(id)).resolves.toBeUndefined();
    expect(await store.get(id)).toBeNull();
  });

  it('issues a slot whose URL targets the local upload route and accepts the PUT', async () => {
    const slot = await store.createUploadSlot({
      ownerId: 'owner-1',
      kind: 'pdf',
      contentType: 'application/pdf',
      maxBytes: 1024,
    });
    expect(slot.method).toBe('PUT');
    expect(slot.url).toBe(`https://api.example/uploads/local/${encodeURIComponent(slot.uploadId)}`);
    expect(slot.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(parseUploadKey(prefix, slot.uploadId)).toEqual({ ownerId: 'owner-1', kind: 'pdf' });

    // The local route writes the body at the issued key.
    await store.writeAt(slot.uploadId, new Uint8Array([0x25, 0x50]));
    expect(await store.head(slot.uploadId)).toEqual({ byteSize: 2 });
  });

  it('purgeExpired drops files past the TTL and keeps fresh ones', async () => {
    const fresh = await store.stage({ ownerId: 'o', kind: 'txt', bytes: new Uint8Array([1]) });
    const stale = await store.stage({ ownerId: 'o', kind: 'txt', bytes: new Uint8Array([2]) });

    // Backdate the stale file's mtime past the TTL.
    const stalePath = resolve(root, stale.id);
    const old = new Date(Date.now() - ttlMs - 60_000);
    await utimes(stalePath, old, old);

    expect(await store.purgeExpired()).toBe(1);
    expect(await store.get(stale.id)).toBeNull();
    expect(await store.get(fresh.id)).not.toBeNull();
  });

  it('refuses to read or write a key that escapes the root', async () => {
    // A traversal key never parses, so every op rejects before touching disk.
    await expect(store.writeAt('../escape__pdf', new Uint8Array([1]))).rejects.toThrow();
    expect(await store.get('../escape__pdf')).toBeNull();

    // Sanity: a planted file outside the prefix is unreachable via the store.
    await writeFile(join(root, 'outside.txt'), 'secret');
    expect(await store.get('outside.txt')).toBeNull();
    await stat(join(root, 'outside.txt')); // still there, untouched
  });
});
