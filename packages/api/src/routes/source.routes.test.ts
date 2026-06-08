/**
 * Source route tests: note/link/file intake (202 + queued job) across the
 * supported upload formats, background ingestion through the real pipeline,
 * listing, drill-in, progress, and owner scoping.
 */

import { IngestionQueueFullError, IngestionRunner } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, silentLogger, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('source routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    auth = ctx.bearerFor('owner@example.com');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/companions',
      headers: auth,
      payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
    });
    companionId = created.json().companion.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('accepts a note with 202, then the background runner ingests it to done', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/note`,
      headers: auth,
      payload: { title: 'Peru notes', text: 'Ceviche is cured with lime.\n\nServed in Lima.' },
    });

    expect(res.statusCode).toBe(202);
    const { source, job } = res.json();
    expect(source.kind).toBe('note');
    expect(source.title).toBe('Peru notes');
    expect(job.status).toBe('queued');

    await ctx.deps.ingestion.whenIdle();
    const progress = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/ingestion`,
      headers: auth,
    });
    const { jobs } = progress.json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('done');
    expect(jobs[0].sectionsDone).toBe(jobs[0].sectionsTotal);

    // Ingestion's LLM + embedding tokens are debited from the companion's stamina
    // wallet, dropping its balance below the seeded start.
    expect(await ctx.deps.quota.getBalance(companionId)).toBeLessThan(
      ctx.deps.config.startingVitalityTokens,
    );
  });

  it('rejects an invalid note body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/note`,
      headers: auth,
      payload: { title: '', text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a link source and records its origin', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/link`,
      headers: auth,
      payload: { url: 'https://example.com/ceviche', title: 'Ceviche article' },
    });

    expect(res.statusCode).toBe(202);
    const { source } = res.json();
    expect(source.kind).toBe('link');
    expect(source.origin).toBe('https://example.com/ceviche');
    // The live fetch fails in tests; the job must land as failed, not hang.
    await ctx.deps.ingestion.whenIdle();
    const progress = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/ingestion`,
      headers: auth,
    });
    expect(['done', 'failed']).toContain(progress.json().jobs[0].status);
  });

  it('deletes a source within its companion and 404s a cross-owner delete', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/note`,
      headers: auth,
      payload: { title: 'Doomed', text: 'Gone soon.\n\nReally.' },
    });
    const sourceId = created.json().source.id;
    await ctx.deps.ingestion.whenIdle();

    // A different owner cannot reach this companion's source.
    const intruder = ctx.bearerFor('intruder@example.com');
    const denied = await ctx.app.inject({
      method: 'DELETE',
      url: `/companions/${companionId}/sources/${sourceId}`,
      headers: intruder,
    });
    expect(denied.statusCode).toBe(404);

    // The owner can; the source (and its job) is gone afterwards.
    const ok = await ctx.app.inject({
      method: 'DELETE',
      url: `/companions/${companionId}/sources/${sourceId}`,
      headers: auth,
    });
    expect(ok.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/sources`,
      headers: auth,
    });
    expect(list.json().sources).toHaveLength(0);
  });

  it('rejects a link with an invalid URL', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/link`,
      headers: auth,
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

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

  it('accepts a PDF upload via multipart and tracks its job', async () => {
    // Valid magic bytes but a corrupt body: intake succeeds, reading fails safely.
    const upload = multipartFile('%PDF-1.4 corrupt body with no objects');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });

    expect(res.statusCode).toBe(202);
    const { source, job } = res.json();
    expect(source.kind).toBe('pdf');
    expect(source.title).toBe('peru-history');
    expect(source.origin).toBe('peru-history.pdf');
    expect(job.status).toBe('queued');

    // Corrupt bytes: ingestion must fail safely with a user-safe error.
    await ctx.deps.ingestion.whenIdle();
    const progress = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/ingestion`,
      headers: auth,
    });
    expect(progress.json().jobs[0].status).toBe('failed');
    expect(progress.json().jobs[0].error).toMatch(/could not finish reading/);
  });

  it('accepts a .txt upload and reads it to done, deriving the title from the filename', async () => {
    const upload = multipartFile('Ceviche is cured in lime.\n\nServed in Lima.', 'peru-notes.txt');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().source.kind).toBe('txt');
    expect(res.json().source.title).toBe('peru-notes');

    await ctx.deps.ingestion.whenIdle();
    const progress = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/ingestion`,
      headers: auth,
    });
    expect(progress.json().jobs[0].status).toBe('done');
  });

  it('writes the attachment chip + acknowledgement to the transcript on a file upload', async () => {
    const upload = multipartFile('Ceviche is cured in lime.', 'peru-notes.txt');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });

    expect(res.statusCode).toBe(202);
    const { source, messages } = res.json();
    // The upload returns its two persisted turns, both linked to the source.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'peru-notes.txt',
      sourceId: source.id,
    });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toMatch(/reading through "peru-notes\.txt" now/);
    expect(messages[1].sourceId).toBe(source.id);

    // They are real, reload-safe transcript turns (fetched back by id).
    const transcript = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/messages`,
      headers: auth,
    });
    const ids = transcript.json().messages.map((m: { id: string }) => m.id);
    expect(ids).toContain(messages[0].id);
    expect(ids).toContain(messages[1].id);
  });

  it('does not write an attachment turn for a note source', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/note`,
      headers: auth,
      payload: { title: 'Peru notes', text: 'Ceviche is cured with lime.' },
    });

    expect(res.statusCode).toBe(202);
    // The note route returns only the source + job — no transcript pair.
    expect(res.json().messages).toBeUndefined();
    // And a note never writes a user-role attachment turn (the completion
    // announcement, if any, is an assistant turn — never a user one).
    const userTurns = (await ctx.deps.memory.getRecentMessages(companionId, 50)).filter(
      (m) => m.role === 'user',
    );
    expect(userTurns).toHaveLength(0);
  });

  it('detects .md and .pptx kinds from the filename', async () => {
    const md = multipartFile('# Heading\n\nBody.', 'trip.md');
    const mdRes = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...md.headers },
      payload: md.payload,
    });
    expect(mdRes.statusCode).toBe(202);
    expect(mdRes.json().source.kind).toBe('md');

    // PK-magic but not a real pptx: intake (kind + magic) passes, reading fails safely.
    const pptx = multipartFile('PK not really a deck', 'deck.pptx');
    const pptxRes = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...pptx.headers },
      payload: pptx.payload,
    });
    expect(pptxRes.statusCode).toBe(202);
    expect(pptxRes.json().source.kind).toBe('pptx');
  });

  it('rejects a .txt whose bytes look binary (NUL byte, no BOM)', async () => {
    const upload = multipartFile('text\x00with a NUL byte', 'notes.txt');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not look like text/);
  });

  it('falls back to a generic title when the filename is only an extension', async () => {
    const upload = multipartFile('Just some prose.', '.txt');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().source.kind).toBe('txt');
    expect(res.json().source.title).toBe('Untitled TXT');
  });

  it('rejects an unsupported file type (400)', async () => {
    const upload = multipartFile('col1,col2\n1,2', 'data.xlsx');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsupported file type/);
  });

  it('rejects a file whose bytes do not match its extension (magic-byte check)', async () => {
    // A .docx that is not a zip — extension lied; magic-byte check must catch it.
    const upload = multipartFile('definitely not a zip', 'fake.docx');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/file`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a valid docx/);
  });

  it('lists sources and serves the section drill-in', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/note`,
      headers: auth,
      payload: { title: 'Peru notes', text: 'Ceviche is cured with lime.' },
    });
    await ctx.deps.ingestion.whenIdle();

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/sources`,
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    const { sources } = list.json();
    expect(sources).toHaveLength(1);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/sources/${sources[0].id}`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(200);
    const { sections } = detail.json();
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0].originalText).toBe('Ceviche is cured with lime.');
  });

  it('owner-scopes every source route', async () => {
    const intruder = ctx.bearerFor('intruder@example.com');
    // Each entry carries a payload valid enough to pass body validation, so a
    // 404 proves the owner check fired (not an incidental 400).
    const routes = [
      {
        method: 'POST' as const,
        url: `/companions/${companionId}/sources/note`,
        payload: { title: 'x', text: 'y' },
      },
      {
        method: 'POST' as const,
        url: `/companions/${companionId}/sources/link`,
        payload: { url: 'https://example.com/x' },
      },
      // File upload checks ownership before reading the file, so a bodyless POST 404s.
      { method: 'POST' as const, url: `/companions/${companionId}/sources/file`, payload: {} },
      { method: 'GET' as const, url: `/companions/${companionId}/sources` },
      { method: 'GET' as const, url: `/companions/${companionId}/sources/${ABSENT_UUID}` },
      { method: 'GET' as const, url: `/companions/${companionId}/ingestion` },
    ];
    for (const route of routes) {
      const res = await ctx.app.inject({
        method: route.method,
        url: route.url,
        headers: intruder,
        ...('payload' in route ? { payload: route.payload } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('returns 429 without creating a job when the ingestion queue is full', async () => {
    // A zero-capacity runner is always full: the route must reject up front.
    const full = await makeTestApp(undefined, undefined, { config: { ingestionQueueMax: 0 } });
    try {
      const ownerAuth = full.bearerFor('owner@example.com');
      const made = await full.app.inject({
        method: 'POST',
        url: '/companions',
        headers: ownerAuth,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      });
      const id = made.json().companion.id;

      const res = await full.app.inject({
        method: 'POST',
        url: `/companions/${id}/sources/note`,
        headers: ownerAuth,
        payload: { title: 'Note', text: 'Body text.' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatch(/busy reading/);

      // No source/job row was created on the rejected submission.
      const progress = await full.app.inject({
        method: 'GET',
        url: `/companions/${id}/ingestion`,
        headers: ownerAuth,
      });
      expect(progress.json().jobs).toHaveLength(0);
    } finally {
      await full.close();
    }
  });

  it('marks the job failed when the queue fills between the up-front check and enqueue', async () => {
    // Fault-injected runner: reports capacity up front but is full by the time
    // the route enqueues — the race the route's catch path exists for.
    class RacingRunner extends IngestionRunner {
      override isFull(): boolean {
        return false;
      }
      override enqueue(): void {
        throw new IngestionQueueFullError();
      }
    }
    const racing = await makeTestApp(undefined, undefined, {
      ingestion: new RacingRunner({ run: () => Promise.resolve() }, silentLogger),
    });
    try {
      const ownerAuth = racing.bearerFor('owner@example.com');
      const made = await racing.app.inject({
        method: 'POST',
        url: '/companions',
        headers: ownerAuth,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      });
      const id = made.json().companion.id;

      const res = await racing.app.inject({
        method: 'POST',
        url: `/companions/${id}/sources/note`,
        headers: ownerAuth,
        payload: { title: 'Note', text: 'Body text.' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatch(/busy reading/);

      // The decline is recorded as data, never a stuck `queued` job.
      const progress = await racing.app.inject({
        method: 'GET',
        url: `/companions/${id}/ingestion`,
        headers: ownerAuth,
      });
      const { jobs } = progress.json();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('failed');
      expect(jobs[0].error).toMatch(/busy reading/);
    } finally {
      await racing.close();
    }
  });
});
