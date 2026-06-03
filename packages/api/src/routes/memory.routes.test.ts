import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('memory routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(['Hi', ' there']);
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

  it('returns a sectioned snapshot with episodic, semantic, and planned sections', async () => {
    await ctx.deps.memory.appendMessage(companionId, 'user', 'hello');
    await ctx.deps.memory.appendMessage(companionId, 'assistant', 'hi');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { memory } = res.json();
    expect(memory.identity.id).toBe(companionId);
    expect(memory.episodic.status).toBe('available');
    expect(memory.episodic.messageCount).toBe(2);
    expect(memory.semantic.status).toBe('available');
    expect(memory.semantic.sourceCount).toBe(0);
    expect(memory.semantic.jobs).toEqual([]);
    expect(memory.procedural.status).toBe('not_implemented');
  });

  it('reflects ingested sources in the semantic section and searches them', async () => {
    // Feed a note through the real ingestion path and wait for the runner.
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/sources/note`,
      headers: auth,
      payload: {
        title: 'Peru notes',
        text: 'Ceviche is cured with lime juice.\n\nIt is served along the Lima coast.',
      },
    });
    expect(created.statusCode).toBe(202);
    await ctx.deps.ingestion.whenIdle();

    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: auth,
    });
    const { memory } = snapshot.json();
    expect(memory.semantic.sourceCount).toBe(1);
    expect(memory.semantic.sectionCount).toBeGreaterThan(0);
    expect(memory.semantic.jobs[0].status).toBe('done');

    const search = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/memory/search`,
      headers: auth,
      payload: { query: 'ceviche lime' },
    });
    expect(search.statusCode).toBe(200);
    const { results } = search.json();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].citation.sourceTitle).toBe('Peru notes');
    expect(results[0].originalText).toContain('Ceviche is cured with lime juice.');
  });

  it('rejects a search without a query', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/memory/search`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a search with 429 when the owner is over the daily token cap', async () => {
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    await ctx.deps.quota.recordUsage(owner.id, ctx.deps.config.tokenCapPerDay);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/memory/search`,
      headers: auth,
      payload: { query: 'ceviche lime' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/allowance/i);
  });

  it('404s the snapshot when the companion is not owned', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${ABSENT_UUID}/memory`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not expose another owner's companion memory", async () => {
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not let another owner search a companion's memory", async () => {
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/memory/search`,
      headers: otherAuth,
      payload: { query: 'ceviche' },
    });
    expect(res.statusCode).toBe(404);
  });
});
