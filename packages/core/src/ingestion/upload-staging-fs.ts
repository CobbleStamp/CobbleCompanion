/**
 * Filesystem-backed upload staging for local dev / CI (staging-object-storage.md
 * §4.1). Bytes live under a configurable root at the same key layout S3 uses, so
 * the rest of the system is backend-agnostic. There is no presigned URL here: a
 * slot points at an API-hosted `PUT /uploads/local/:uploadId` route that calls
 * {@link FilesystemUploadStagingStore.writeAt}. Expiry is a wall-clock sweep
 * (`purgeExpired`) rather than a bucket lifecycle rule.
 */

import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  buildUploadKey,
  parseUploadKey,
  type CreateUploadSlotParams,
  type StageUploadParams,
  type StagedUpload,
  type UploadSlot,
  type UploadStagingStore,
} from './upload-staging.js';

export interface FilesystemStagingConfig {
  /** Directory under which staged objects are written. */
  readonly root: string;
  /** Key prefix (mirrors the S3 prefix), e.g. `tmp-uploads`. */
  readonly prefix: string;
  /** How long a staged object lives before `purgeExpired` reclaims it. */
  readonly ttlMs: number;
  /** Public base URL of the API, used to build the local upload-slot URL. */
  readonly publicBaseUrl: string;
}

export class FilesystemUploadStagingStore implements UploadStagingStore {
  constructor(private readonly config: FilesystemStagingConfig) {}

  async createUploadSlot(params: CreateUploadSlotParams): Promise<UploadSlot> {
    const uploadId = buildUploadKey(this.config.prefix, params.ownerId, params.kind);
    const base = this.config.publicBaseUrl.replace(/\/+$/, '');
    return {
      uploadId,
      url: `${base}/uploads/local/${encodeURIComponent(uploadId)}`,
      method: 'PUT',
      ...(params.contentType ? { headers: { 'content-type': params.contentType } } : {}),
      expiresAt: this.expiryFromNow(),
    };
  }

  async stage(params: StageUploadParams): Promise<{ id: string }> {
    const id = buildUploadKey(this.config.prefix, params.ownerId, params.kind);
    await this.writeAt(id, params.bytes);
    return { id };
  }

  /**
   * Persist bytes at a previously-issued key (the local upload route's sink).
   * Rejects a key that does not resolve under the root or fails to parse.
   */
  async writeAt(id: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(id);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, bytes);
  }

  async head(id: string): Promise<{ byteSize: number } | null> {
    try {
      const info = await stat(this.pathFor(id));
      return { byteSize: info.size };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async peek(id: string, n: number): Promise<Uint8Array | null> {
    if (n <= 0) {
      return new Uint8Array(0);
    }
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.pathFor(id), 'r');
      const buffer = Buffer.alloc(n);
      const { bytesRead } = await handle.read(buffer, 0, n, 0);
      return Uint8Array.from(buffer.subarray(0, bytesRead));
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async get(id: string): Promise<StagedUpload | null> {
    const parsed = parseUploadKey(this.config.prefix, id);
    if (!parsed) {
      return null;
    }
    try {
      const bytes = await readFile(this.pathFor(id));
      return { id, kind: parsed.kind, bytes: new Uint8Array(bytes) };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  async purgeExpired(): Promise<number> {
    const root = resolve(this.config.root, this.config.prefix);
    const cutoff = Date.now() - this.config.ttlMs;
    let purged = 0;
    for (const file of await this.walk(root)) {
      const info = await stat(file).catch(() => null);
      if (info && info.isFile() && info.mtimeMs < cutoff) {
        await rm(file, { force: true });
        purged += 1;
      }
    }
    return purged;
  }

  /** Resolve a key to an absolute path, rejecting traversal outside the root. */
  private pathFor(id: string): string {
    const root = resolve(this.config.root);
    // Parse first so a malformed/forged key never reaches the filesystem, then
    // confirm the resolved path stays under the root (defence against traversal).
    if (!parseUploadKey(this.config.prefix, id)) {
      throw new Error('invalid staging key');
    }
    const full = resolve(root, id);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error('staging key escapes the configured root');
    }
    return full;
  }

  /** Recursively list every file under `dir` (absent dir → empty). */
  private async walk(dir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
    const files: string[] = [];
    for (const name of names) {
      const child = join(dir, name);
      const info = await stat(child).catch(() => null);
      if (!info) {
        continue;
      }
      if (info.isDirectory()) {
        files.push(...(await this.walk(child)));
      } else if (info.isFile()) {
        files.push(child);
      }
    }
    return files;
  }

  private expiryFromNow(): string {
    return new Date(Date.now() + this.config.ttlMs).toISOString();
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
