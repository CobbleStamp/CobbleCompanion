/**
 * Source intake — all WS methods (`sources.*`, `ingestion.list`), exercised over
 * the WS harness on an embodied connection against an in-memory staging fake
 * (staging-object-storage.md). The file-upload path is the two-step presigned
 * flow: `sources.requestFileUpload` issues a slot, the test writes the bytes into
 * the fake, then `sources.file` runs its kind detection, magic-byte gate,
 * transcript pair, ownership check, and backpressure. Note/link intake, listing,
 * drill-in, deletion, and ingestion progress round it out. (The filesystem upload
 * sink `PUT /uploads/local/:uploadId` is covered in `uploads-local.routes.test.ts`.)
 */

import type { UploadSlotDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryUploadStagingStore } from '../test/fake-upload-staging.js';
import { makeTestApp, type TestApp } from '../test/helpers.js';
import { openWs, WsCallError, type WsTestClient } from '../test/ws-client.js';

describe('source intake', () => {
  let ctx: TestApp;
  let companionId: string;
  let ws: WsTestClient;

  beforeEach(async () => {
    ctx = await makeTestApp();
    const anon = await openWs(ctx, 'owner@example.com');
    const { companion } = await anon.call<{ companion: { id: string } }>('companions.create', {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    await anon.close();
    companionId = companion.id;
    ws = await openWs(ctx, 'owner@example.com', companionId);
  });

  afterEach(async () => {
    await ws.close();
    await ctx.close();
  });

  // ---- WS source methods (note/link/list/get/delete/ingestion) ----

  it('accepts a note (sources.note), then the background runner ingests it to done', async () => {
    const { source, job } = await ws.call<{
      source: { kind: string; title: string };
      job: { status: string };
    }>('sources.note', {
      title: 'Peru notes',
      text: 'Ceviche is cured with lime.\n\nServed in Lima.',
    });
    expect(source.kind).toBe('note');
    expect(source.title).toBe('Peru notes');
    expect(job.status).toBe('queued');

    await ctx.deps.ingest.whenIdle();
    const { jobs } = await ws.call<{
      jobs: { status: string; sectionsDone: number; sectionsTotal: number }[];
    }>('ingestion.list');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('done');
    expect(jobs[0]!.sectionsDone).toBe(jobs[0]!.sectionsTotal);
    // Ingestion's LLM + embedding tokens are debited from the companion's wallet.
    expect(await ctx.deps.quota.getBalance(companionId)).toBeLessThan(
      ctx.deps.config.startingVitalityTokens,
    );
  });

  it('rejects an invalid note body (bad_params)', async () => {
    await expect(ws.call('sources.note', { title: '', text: '' })).rejects.toMatchObject({
      code: 'bad_params',
    });
  });

  it('accepts a link source and records its origin', async () => {
    const { source } = await ws.call<{ source: { kind: string; origin: string } }>('sources.link', {
      url: 'https://example.com/ceviche',
      title: 'Ceviche article',
    });
    expect(source.kind).toBe('link');
    expect(source.origin).toBe('https://example.com/ceviche');
    // The live fetch fails in tests; the job must land terminal, not hang.
    await ctx.deps.ingest.whenIdle();
    const { jobs } = await ws.call<{ jobs: { status: string }[] }>('ingestion.list');
    expect(['done', 'failed']).toContain(jobs[0]!.status);
  });

  it('rejects a link with an invalid URL (bad_params)', async () => {
    await expect(ws.call('sources.link', { url: 'not-a-url' })).rejects.toBeInstanceOf(WsCallError);
  });

  it('lists sources and serves the section drill-in', async () => {
    await ws.call('sources.note', { title: 'Peru notes', text: 'Ceviche is cured with lime.' });
    await ctx.deps.ingest.whenIdle();

    const { sources } = await ws.call<{ sources: { id: string }[] }>('sources.list');
    expect(sources).toHaveLength(1);

    const { sections } = await ws.call<{ sections: { originalText: string }[] }>('sources.get', {
      sourceId: sources[0]!.id,
    });
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]!.originalText).toBe('Ceviche is cured with lime.');
  });

  it('deletes a source; a missing source is not_found', async () => {
    const { source } = await ws.call<{ source: { id: string } }>('sources.note', {
      title: 'Doomed',
      text: 'Gone soon.\n\nReally.',
    });
    await ctx.deps.ingest.whenIdle();

    await ws.call('sources.delete', { sourceId: source.id });
    const { sources } = await ws.call<{ sources: unknown[] }>('sources.list');
    expect(sources).toHaveLength(0);

    await expect(ws.call('sources.delete', { sourceId: source.id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('does not write an attachment turn for a note source', async () => {
    await ws.call('sources.note', { title: 'Peru notes', text: 'Ceviche is cured with lime.' });
    const userTurns = (await ctx.deps.memory.getRecentMessages(companionId, 50)).filter(
      (m) => m.role === 'user',
    );
    expect(userTurns).toHaveLength(0);
  });

  it('rejects a note when the ingestion queue is full (over capacity)', async () => {
    const full = await makeTestApp(undefined, undefined, { config: { ingestionQueueMax: 0 } });
    try {
      const anon = await openWs(full, 'owner@example.com');
      const { companion } = await anon.call<{ companion: { id: string } }>('companions.create', {
        name: 'Pebble',
        form: 'fox',
        temperament: 'curious',
      });
      await anon.close();
      const fullWs = await openWs(full, 'owner@example.com', companion.id);
      try {
        await expect(
          fullWs.call('sources.note', { title: 'Note', text: 'Body text.' }),
        ).rejects.toThrow(/busy reading/);
        const { jobs } = await fullWs.call<{ jobs: unknown[] }>('ingestion.list');
        expect(jobs).toHaveLength(0);
      } finally {
        await fullWs.close();
      }
    } finally {
      await full.close();
    }
  });

  // ---- File upload (presigned two-step WS flow; staging-object-storage.md) ----

  /**
   * Simulate the full presigned upload: request a slot, "PUT" the bytes (seeded
   * into the in-memory staging fake at the slot's key), then enqueue via
   * `sources.file`. Returns the enqueue result.
   */
  async function uploadFile(
    body: string,
    filename = 'peru-history.pdf',
  ): Promise<{
    source: { id: string; kind: string; title: string; origin: string };
    job: { status: string };
    messages: { id: string; role: string; content: string; sourceId: string | null }[];
  }> {
    const bytes = new TextEncoder().encode(body);
    const slot = await ws.call<UploadSlotDto>('sources.requestFileUpload', {
      filename,
      byteSize: bytes.byteLength,
    });
    const staging = ctx.deps.staging as InMemoryUploadStagingStore;
    staging.put(slot.uploadId, bytes);
    return ws.call('sources.file', { uploadId: slot.uploadId, filename });
  }

  it('issues an owner-scoped slot whose key carries the kind', async () => {
    const slot = await ws.call<UploadSlotDto>('sources.requestFileUpload', {
      filename: 'peru-history.pdf',
      byteSize: 1024,
    });
    expect(slot.method).toBe('PUT');
    expect(slot.url).toContain(`/uploads/local/${encodeURIComponent(slot.uploadId)}`);
    expect(slot.uploadId).toMatch(/__pdf$/);
  });

  it('rejects requesting a slot for an unsupported file type (bad_params)', async () => {
    await expect(
      ws.call('sources.requestFileUpload', { filename: 'data.xlsx', byteSize: 1024 }),
    ).rejects.toMatchObject({ code: 'bad_params' });
  });

  it('rejects a slot request for a file larger than the ingestion cap (bad_params)', async () => {
    await expect(
      ws.call('sources.requestFileUpload', {
        filename: 'huge.pdf',
        byteSize: 25 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({ code: 'bad_params' });
  });

  it('accepts a PDF upload and tracks its job', async () => {
    // Valid magic bytes but a corrupt body: intake succeeds, reading fails safely.
    const { source, job } = await uploadFile('%PDF-1.4 corrupt body with no objects');
    expect(source.kind).toBe('pdf');
    expect(source.title).toBe('peru-history');
    expect(source.origin).toBe('peru-history.pdf');
    expect(job.status).toBe('queued');

    await ctx.deps.ingest.whenIdle();
    const { jobs } = await ws.call<{ jobs: { status: string; error: string | null }[] }>(
      'ingestion.list',
    );
    expect(jobs[0]!.status).toBe('failed');
    expect(jobs[0]!.error).toMatch(/could not finish reading/);
  });

  it('accepts a .txt upload and reads it to done, deriving the title from the filename', async () => {
    const { source } = await uploadFile(
      'Ceviche is cured in lime.\n\nServed in Lima.',
      'peru-notes.txt',
    );
    expect(source.kind).toBe('txt');
    expect(source.title).toBe('peru-notes');

    await ctx.deps.ingest.whenIdle();
    const { jobs } = await ws.call<{ jobs: { status: string }[] }>('ingestion.list');
    expect(jobs[0]!.status).toBe('done');
  });

  it('writes the attachment chip + acknowledgement to the transcript on a file upload', async () => {
    const { source, messages } = await uploadFile('Ceviche is cured in lime.', 'peru-notes.txt');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'peru-notes.txt',
      sourceId: source.id,
    });
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.content).toMatch(/reading through "peru-notes\.txt" now/);
    expect(messages[1]!.sourceId).toBe(source.id);

    // They are real, reload-safe transcript turns (fetched back by id over the WS).
    const { messages: transcript } = await ws.call<{ messages: { id: string }[] }>('messages.list');
    const ids = transcript.map((m) => m.id);
    expect(ids).toContain(messages[0]!.id);
    expect(ids).toContain(messages[1]!.id);
  });

  it('detects .md and .pptx kinds from the filename', async () => {
    const md = await uploadFile('# Heading\n\nBody.', 'trip.md');
    expect(md.source.kind).toBe('md');

    // PK-magic but not a real pptx: intake passes, reading fails safely.
    const pptx = await uploadFile('PK not really a deck', 'deck.pptx');
    expect(pptx.source.kind).toBe('pptx');
  });

  it('rejects a .txt whose bytes look binary (NUL byte, no BOM)', async () => {
    await expect(uploadFile('text\x00with a NUL byte', 'notes.txt')).rejects.toMatchObject({
      code: 'bad_params',
    });
  });

  it('falls back to a generic title when the filename is only an extension', async () => {
    const { source } = await uploadFile('Just some prose.', '.txt');
    expect(source.kind).toBe('txt');
    expect(source.title).toBe('Untitled TXT');
  });

  it('rejects enqueuing a file whose bytes do not match its extension (magic-byte check)', async () => {
    // A .docx that is not a zip — extension lied; the peek magic-byte check catches it.
    await expect(uploadFile('definitely not a zip', 'fake.docx')).rejects.toMatchObject({
      code: 'bad_params',
    });
  });

  it('rejects enqueuing an upload that was never PUT (empty/missing → bad_params)', async () => {
    const slot = await ws.call<UploadSlotDto>('sources.requestFileUpload', {
      filename: 'ghost.pdf',
      byteSize: 1024,
    });
    // No staging.put — the client never uploaded.
    await expect(
      ws.call('sources.file', { uploadId: slot.uploadId, filename: 'ghost.pdf' }),
    ).rejects.toMatchObject({ code: 'bad_params' });
  });

  it("owner-scopes enqueue: another user can't claim this owner's uploadId (not_found)", async () => {
    const slot = await ws.call<UploadSlotDto>('sources.requestFileUpload', {
      filename: 'peru-history.pdf',
      byteSize: 1024,
    });
    (ctx.deps.staging as InMemoryUploadStagingStore).put(
      slot.uploadId,
      new TextEncoder().encode('%PDF-1.4 body'),
    );

    // A second user, embodied in their own companion, tries the first owner's key.
    const intruderAnon = await openWs(ctx, 'intruder@example.com');
    const { companion: intruderCompanion } = await intruderAnon.call<{
      companion: { id: string };
    }>('companions.create', { name: 'Rocky', form: 'cat', temperament: 'aloof' });
    await intruderAnon.close();
    const intruderWs = await openWs(ctx, 'intruder@example.com', intruderCompanion.id);
    try {
      await expect(
        intruderWs.call('sources.file', { uploadId: slot.uploadId, filename: 'peru-history.pdf' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await intruderWs.close();
    }
  });
});
