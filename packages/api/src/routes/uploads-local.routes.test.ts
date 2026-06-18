/**
 * The filesystem-backend upload route `PUT /uploads/local/:uploadId`
 * (staging-object-storage.md §5) — mounted only when staging is filesystem-backed.
 * It is the local equivalent of a presigned S3 PUT: owner-scoped and size-capped.
 * Slots are issued by the real `sources.requestFileUpload` WS method so the key
 * carries the authenticated owner; the test then PUTs the bytes to the slot URL.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemUploadStagingStore } from '@cobble/core';
import type { UploadSlotDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';
import { openWs, type WsTestClient } from '../test/ws-client.js';

describe('PUT /uploads/local/:uploadId (filesystem backend)', () => {
  let ctx: TestApp;
  let root: string;
  let store: FilesystemUploadStagingStore;
  let owner: { authorization: string };
  let ws: WsTestClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-fsroute-'));
    store = new FilesystemUploadStagingStore({
      root,
      prefix: 'tmp-uploads',
      ttlMs: 60_000,
      publicBaseUrl: 'http://localhost:3000',
    });
    ctx = await makeTestApp(undefined, undefined, { staging: store });
    owner = ctx.bearerFor('owner@example.com');
    ws = await openWs(ctx, 'owner@example.com');
  });

  afterEach(async () => {
    await ws.close();
    await ctx.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A slot for the authenticated owner, plus the inject path for its URL. */
  async function ownerSlot(filename = 'doc.pdf'): Promise<{ slot: UploadSlotDto; path: string }> {
    const slot = await ws.call<UploadSlotDto>('sources.requestFileUpload', {
      filename,
      byteSize: 1024,
    });
    const url = new URL(slot.url);
    return { slot, path: `${url.pathname}${url.search}` };
  }

  it('writes the PUT body at the slot key for the owner', async () => {
    const { slot, path } = await ownerSlot();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: path,
      headers: { ...owner, 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4 hello'),
    });
    expect(res.statusCode).toBe(204);

    const staged = await store.get(slot.uploadId);
    expect(staged ? new TextDecoder().decode(staged.bytes) : null).toBe('%PDF-1.4 hello');
  });

  it('rejects an empty body (400)', async () => {
    const { path } = await ownerSlot();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: path,
      headers: { ...owner, 'content-type': 'application/pdf' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the caller is not the slot owner', async () => {
    const { slot, path } = await ownerSlot();
    const intruder = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'PUT',
      url: path,
      headers: { ...intruder, 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4 body'),
    });
    expect(res.statusCode).toBe(404);
    expect(await store.get(slot.uploadId)).toBeNull();
  });
});
