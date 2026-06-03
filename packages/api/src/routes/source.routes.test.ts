/**
 * Source route tests: note/link/PDF intake (202 + queued job), background
 * ingestion through the real pipeline, listing, drill-in, progress, and
 * owner scoping.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

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

  it('accepts a PDF upload via multipart and tracks its job', async () => {
    const boundary = 'test-boundary-7f3a';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="peru-history.pdf"',
      'Content-Type: application/pdf',
      '',
      'not a real pdf body',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/pdf`,
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    const { source, job } = res.json();
    expect(source.kind).toBe('pdf');
    expect(source.title).toBe('peru-history');
    expect(source.origin).toBe('peru-history.pdf');
    expect(job.status).toBe('queued');

    // Garbage bytes: ingestion must fail safely with a user-safe error.
    await ctx.deps.ingestion.whenIdle();
    const progress = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/ingestion`,
      headers: auth,
    });
    expect(progress.json().jobs[0].status).toBe('failed');
    expect(progress.json().jobs[0].error).toMatch(/could not finish reading/);
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
    const routes = [
      { method: 'POST' as const, url: `/companions/${companionId}/sources/note` },
      { method: 'GET' as const, url: `/companions/${companionId}/sources` },
      { method: 'GET' as const, url: `/companions/${companionId}/sources/${ABSENT_UUID}` },
      { method: 'GET' as const, url: `/companions/${companionId}/ingestion` },
    ];
    for (const route of routes) {
      const res = await ctx.app.inject({
        ...route,
        headers: intruder,
        ...(route.method === 'POST' ? { payload: { title: 'x', text: 'y' } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
