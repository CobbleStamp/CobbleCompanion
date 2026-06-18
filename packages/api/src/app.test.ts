import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemUploadStagingStore, type Logger } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactUrl } from './app.js';
import { makeTestApp, type TestApp } from './test/helpers.js';

interface LogEntry {
  readonly message: string;
  readonly context: Record<string, unknown>;
}

/** Capturing logger so tests can assert errors are logged with full context. */
function capturingLogger(error: LogEntry[], info: LogEntry[]): Logger {
  return {
    error: (message, context) => error.push({ message, context }),
    warn: (message, context) => info.push({ message, context: context ?? {} }),
    info: (message, context) => info.push({ message, context: context ?? {} }),
  };
}

describe('app error logging (common/logging.md)', () => {
  let errors: LogEntry[];
  let infos: LogEntry[];
  let ctx: TestApp;
  let root: string;
  let store: FilesystemUploadStagingStore;

  beforeEach(async () => {
    errors = [];
    infos = [];
    // The error-logging middleware is exercised through the one remaining HTTP
    // write route — the filesystem upload sink (staging-object-storage.md) — so
    // use a filesystem-backed staging store, which mounts `PUT /uploads/local`.
    root = await mkdtemp(join(tmpdir(), 'cc-apptest-'));
    store = new FilesystemUploadStagingStore({
      root,
      prefix: 'tmp-uploads',
      ttlMs: 60_000,
      publicBaseUrl: 'http://localhost:3000',
    });
    ctx = await makeTestApp(['Hi'], capturingLogger(errors, infos), { staging: store });
  });
  afterEach(async () => {
    await ctx.close();
    await rm(root, { recursive: true, force: true });
  });

  it('logs an unexpected 5xx with full context and never leaks internals', async () => {
    // Force a genuine internal failure deep in a handler (the staging write throws)
    // to exercise the 5xx path. The key must be a valid, owner-matching slot so the
    // request reaches the write — otherwise it is a clean 404 (owner guard).
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    const slot = await store.createUploadSlot({
      ownerId: owner.id,
      kind: 'pdf',
      contentType: 'application/pdf',
      maxBytes: 1024,
      byteSize: 13,
    });
    store.writeAt = async () => {
      throw new Error('boom');
    };
    const url = `/uploads/local/${encodeURIComponent(slot.uploadId)}`;
    const res = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: { ...ctx.bearerFor('owner@example.com'), 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4 body'),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'could not store the upload' });

    // The handler logs the failure itself with full context (logging.md), and the
    // generic onResponse hook never leaks internals to the client.
    const entry = errors.find((e) => e.context.operation === 'uploads.local.put');
    expect(entry).toBeDefined();
    expect(entry!.context.error).toBeInstanceOf(Error);
  });

  it('redacts a credential query param from the 5xx error log', async () => {
    // A WS handshake failure routes through this same error handler, and the
    // browser bearer rides the URL as ?access_token=<jwt>. The log must carry the
    // redacted URL, never the live token (regression guard for app.ts:243).
    ctx.deps.identity.getCompanion = async () => {
      throw new Error('boom');
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/companions/00000000-0000-0000-0000-000000000000/sources/file?access_token=live.jwt',
      headers: ctx.bearerFor('owner@example.com'),
    });

    expect(res.statusCode).toBe(500);
    expect(errors).toHaveLength(1);
    const loggedUrl = errors[0]!.context.url;
    expect(loggedUrl).not.toContain('live.jwt');
    expect(loggedUrl).toContain('access_token=REDACTED');
  });

  it('rejects a malformed resource id with a clean 404, not a 500', async () => {
    // The uuid param guard short-circuits a non-UUID resource id before any DB
    // query. No HTTP route carries a uuid param anymore, so the guard itself is
    // unit-tested in uuid.test.ts; here we confirm an unknown HTTP path is a clean
    // 404 (Fastify default), never a 500, and is not logged as an error.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/companions/not-a-uuid/does-not-exist',
      headers: ctx.bearerFor('owner@example.com'),
    });

    expect(res.statusCode).toBe(404);
    expect(errors).toHaveLength(0);
  });

  it('logs a 4xx client error at info severity, not error', async () => {
    // A malformed JSON body is rejected by the content-type parser with a 400
    // before the handler runs; the generic hook logs it at info, not error.
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/uploads/local/whatever',
      headers: { ...ctx.bearerFor('owner@example.com'), 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    expect(res.statusCode).toBe(400);
    expect(errors).toHaveLength(0);
    expect(
      infos.some((e) => e.message === 'request rejected' && e.context.statusCode === 400),
    ).toBe(true);
  });
});

describe('redactUrl (S1 — access-log token redaction)', () => {
  it('redacts the access_token a browser WebSocket sends in the handshake URL', () => {
    // ws/handshake.ts accepts the bearer as ?access_token=<jwt>; the access log
    // must never carry a live, replayable token.
    expect(redactUrl('/ws?access_token=eyJhbG.live.jwt&companion=c_123')).toBe(
      '/ws?access_token=REDACTED&companion=c_123',
    );
  });

  it('redacts a bare token param', () => {
    expect(redactUrl('/ws?token=secret')).toBe('/ws?token=REDACTED');
  });

  it('leaves a URL with no query string untouched', () => {
    expect(redactUrl('/companions/c_123/messages')).toBe('/companions/c_123/messages');
  });

  it('preserves non-sensitive query params verbatim', () => {
    expect(redactUrl('/ws?companion=c_123')).toBe('/ws?companion=c_123');
  });

  it('redacts every credential param when several are present', () => {
    expect(redactUrl('/ws?access_token=a&token=b&companion=c_123')).toBe(
      '/ws?access_token=REDACTED&token=REDACTED&companion=c_123',
    );
  });
});
