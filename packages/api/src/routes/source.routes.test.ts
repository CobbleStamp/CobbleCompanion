/**
 * Source intake. The multipart file upload is the one HTTP route (bulk bytes;
 * D-A's two-part upload) — its kind detection, magic-byte gate, transcript pair,
 * ownership, and backpressure are exercised over `inject`. Note/link intake,
 * listing, drill-in, deletion, and ingestion progress are WS methods (`sources.*`,
 * `ingestion.list`), exercised over the WS harness on an embodied connection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';
import { openWs, WsCallError, type WsTestClient } from '../test/ws-client.js';

describe('source intake', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;
  let ws: WsTestClient;

  beforeEach(async () => {
    ctx = await makeTestApp();
    auth = ctx.bearerFor('owner@example.com');
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

  // ---- File upload (HTTP — the one remaining route) ----

  function multipartFile(
    fileBody: string,
    filename = 'peru-history.pdf',
    contentType = 'application/octet-stream',
  ): { headers: Record<string, string>; payload: string } {
    const boundary = 'test-boundary-7f3a';
    const payload = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${contentType}`,
      '',
      fileBody,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    };
  }

  function uploadFile(body: string, filename?: string) {
    const upload = multipartFile(body, filename);
    return ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });
  }

  it('accepts a PDF upload via multipart and tracks its job', async () => {
    // Valid magic bytes but a corrupt body: intake succeeds, reading fails safely.
    const res = await uploadFile('%PDF-1.4 corrupt body with no objects');
    expect(res.statusCode).toBe(202);
    const { source, job } = res.json();
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
    const res = await uploadFile('Ceviche is cured in lime.\n\nServed in Lima.', 'peru-notes.txt');
    expect(res.statusCode).toBe(202);
    expect(res.json().source.kind).toBe('txt');
    expect(res.json().source.title).toBe('peru-notes');

    await ctx.deps.ingest.whenIdle();
    const { jobs } = await ws.call<{ jobs: { status: string }[] }>('ingestion.list');
    expect(jobs[0]!.status).toBe('done');
  });

  it('writes the attachment chip + acknowledgement to the transcript on a file upload', async () => {
    const res = await uploadFile('Ceviche is cured in lime.', 'peru-notes.txt');
    expect(res.statusCode).toBe(202);
    const { source, messages } = res.json();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'peru-notes.txt',
      sourceId: source.id,
    });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toMatch(/reading through "peru-notes\.txt" now/);
    expect(messages[1].sourceId).toBe(source.id);

    // They are real, reload-safe transcript turns (fetched back by id over the WS).
    const { messages: transcript } = await ws.call<{ messages: { id: string }[] }>('messages.list');
    const ids = transcript.map((m) => m.id);
    expect(ids).toContain(messages[0].id);
    expect(ids).toContain(messages[1].id);
  });

  it('detects .md and .pptx kinds from the filename', async () => {
    const mdRes = await uploadFile('# Heading\n\nBody.', 'trip.md');
    expect(mdRes.statusCode).toBe(202);
    expect(mdRes.json().source.kind).toBe('md');

    // PK-magic but not a real pptx: intake passes, reading fails safely.
    const pptxRes = await uploadFile('PK not really a deck', 'deck.pptx');
    expect(pptxRes.statusCode).toBe(202);
    expect(pptxRes.json().source.kind).toBe('pptx');
  });

  it('rejects a .txt whose bytes look binary (NUL byte, no BOM)', async () => {
    const res = await uploadFile('text\x00with a NUL byte', 'notes.txt');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not look like text/);
  });

  it('falls back to a generic title when the filename is only an extension', async () => {
    const res = await uploadFile('Just some prose.', '.txt');
    expect(res.statusCode).toBe(202);
    expect(res.json().source.kind).toBe('txt');
    expect(res.json().source.title).toBe('Untitled TXT');
  });

  it('rejects an unsupported file type (400)', async () => {
    const res = await uploadFile('col1,col2\n1,2', 'data.xlsx');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsupported file type/);
  });

  it('rejects a file whose bytes do not match its extension (magic-byte check)', async () => {
    // A .docx that is not a zip — extension lied; magic-byte check must catch it.
    const res = await uploadFile('definitely not a zip', 'fake.docx');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a valid docx/);
  });

  it('owner-scopes the file upload (404 for a non-owner)', async () => {
    const intruder = ctx.bearerFor('intruder@example.com');
    const upload = multipartFile('%PDF-1.4 body');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...intruder, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(404);
  });
});
