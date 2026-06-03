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

  it('rate-limits memory search per owner without throttling other owners', async () => {
    const limited = await makeTestApp(['Hi'], undefined, { config: { searchRateMax: 2 } });
    try {
      const makeCompanion = async (ownerAuth: { authorization: string }): Promise<string> => {
        const made = await limited.app.inject({
          method: 'POST',
          url: '/companions',
          headers: ownerAuth,
          payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
        });
        return made.json().companion.id as string;
      };
      const search = (
        ownerAuth: { authorization: string },
        id: string,
      ): Promise<{ statusCode: number; body: string }> =>
        limited.app
          .inject({
            method: 'POST',
            url: `/companions/${id}/memory/search`,
            headers: ownerAuth,
            payload: { query: 'anything' },
          })
          .then((r) => ({ statusCode: r.statusCode, body: r.body }));

      const ownerAuth = limited.bearerFor('owner@example.com');
      const ownerCompanion = await makeCompanion(ownerAuth);
      expect((await search(ownerAuth, ownerCompanion)).statusCode).toBe(200);
      expect((await search(ownerAuth, ownerCompanion)).statusCode).toBe(200);
      const third = await search(ownerAuth, ownerCompanion);
      // Must be the friendly 429 from the central handler, not a masked 500.
      expect(third.statusCode).toBe(429);
      expect(JSON.parse(third.body).error).toMatch(/too many requests/);

      // The limit is keyed per owner: another owner's budget is untouched.
      const otherAuth = limited.bearerFor('other@example.com');
      const otherCompanion = await makeCompanion(otherAuth);
      expect((await search(otherAuth, otherCompanion)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
