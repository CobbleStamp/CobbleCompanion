/**
 * Source route tests: note/link/PDF intake (202 + queued job), background
 * ingestion through the real pipeline, listing, drill-in, progress, and
 * owner scoping.
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

  it('rejects a link with an invalid URL', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/link`,
      headers: auth,
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  function multipartPdf(fileBody: string): { headers: Record<string, string>; payload: string } {
    const boundary = 'test-boundary-7f3a';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="peru-history.pdf"',
      'Content-Type: application/pdf',
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
    const upload = multipartPdf('%PDF-1.4 corrupt body with no objects');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/pdf`,
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

  it('rejects an upload that is not a PDF (magic-byte check)', async () => {
    const upload = multipartPdf('definitely not a pdf');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/pdf`,
      headers: { ...auth, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a PDF/);
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
      // PDF checks ownership before reading the file, so a bodyless POST 404s.
      { method: 'POST' as const, url: `/companions/${companionId}/sources/pdf`, payload: {} },
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

  it('rate-limits ingestion per owner with one cap shared across note and link', async () => {
    const limited = await makeTestApp(undefined, undefined, { config: { ingestionRateMax: 2 } });
    try {
      const ownerAuth = limited.bearerFor('owner@example.com');
      const made = await limited.app.inject({
        method: 'POST',
        url: '/companions',
        headers: ownerAuth,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      });
      const id = made.json().companion.id;
      const submitNote = (): Promise<{ statusCode: number; body: string }> =>
        limited.app
          .inject({
            method: 'POST',
            url: `/companions/${id}/sources/note`,
            headers: ownerAuth,
            payload: { title: 'Note', text: 'Body text.' },
          })
          .then((r) => ({ statusCode: r.statusCode, body: r.body }));

      // INGESTION_RATE_MAX is documented as the cap across PDF/note/link
      // combined — a note and a link together exhaust a cap of 2.
      expect((await submitNote()).statusCode).toBe(202);
      const link = await limited.app.inject({
        method: 'POST',
        url: `/companions/${id}/sources/link`,
        headers: ownerAuth,
        payload: { url: 'https://example.com/article' },
      });
      expect(link.statusCode).toBe(202);
      const third = await submitNote();
      expect(third.statusCode).toBe(429);
      expect(JSON.parse(third.body).error).toMatch(/too many requests/);
    } finally {
      await limited.close();
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
