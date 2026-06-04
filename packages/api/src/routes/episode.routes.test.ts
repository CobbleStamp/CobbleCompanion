import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('episode routes', () => {
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

  /** Seed an episode directly through the store (consolidation is covered in core). */
  async function seedEpisode(summary: string, day: string, seqEnd: number): Promise<void> {
    await ctx.deps.episodic.appendEpisodes(
      companionId,
      [
        {
          summary,
          seqStart: seqEnd - 3,
          seqEnd,
          occurredStart: new Date(`${day}T00:00:00Z`),
          occurredEnd: new Date(`${day}T01:00:00Z`),
          salience: 0.8,
        },
      ],
      seqEnd,
    );
  }

  it('returns the episode timeline most-recent-first', async () => {
    await seedEpisode('You loved the ceviche in Lima', '2026-01-10', 4);
    await seedEpisode('You hiked Rainbow Mountain', '2026-03-10', 8);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/episodes`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { episodes } = res.json();
    expect(episodes.map((e: { summary: string }) => e.summary)).toEqual([
      'You hiked Rainbow Mountain',
      'You loved the ceviche in Lima',
    ]);
    expect(episodes[0].occurredStart).toBe('2026-03-10T00:00:00.000Z');
    expect(episodes[0].salience).toBe(0.8);
  });

  it('recalls episodes by topic (lexical match on the summary)', async () => {
    await seedEpisode('You loved the ceviche in Lima', '2026-01-10', 4);
    await seedEpisode('You debugged your printer for an hour', '2026-02-10', 8);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: auth,
      payload: { query: 'ceviche' },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(1);
    expect(results[0].episode.summary).toContain('ceviche');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('rejects a search without a query', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a search with 429 when over the daily token cap', async () => {
    const owner = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    await ctx.deps.quota.recordUsage(owner.id, ctx.deps.config.tokenCapPerDay);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: auth,
      payload: { query: 'ceviche' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('surfaces the episode count in the memory snapshot', async () => {
    await seedEpisode('You loved the ceviche in Lima', '2026-01-10', 4);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/memory`,
      headers: auth,
    });
    expect(res.json().memory.episodic.episodeCount).toBe(1);
  });

  it('rejects a search whose topK falls outside [1, 20] or is non-integer', async () => {
    const badTopKs: readonly number[] = [0, -1, 21, 2.5];
    for (const topK of badTopKs) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/companions/${companionId}/episodes/search`,
        headers: auth,
        payload: { query: 'ceviche', topK },
      });
      expect(res.statusCode, `topK=${topK} should be rejected`).toBe(400);
    }
  });

  it('accepts a topK within [1, 20] and defaults topK when omitted', async () => {
    await seedEpisode('You loved the ceviche in Lima', '2026-01-10', 4);

    const withinBounds = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: auth,
      payload: { query: 'ceviche', topK: 20 },
    });
    expect(withinBounds.statusCode).toBe(200);

    const omitted = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: auth,
      payload: { query: 'ceviche' },
    });
    expect(omitted.statusCode).toBe(200);
  });

  it('degrades to lexical-only recall when the embeddings gateway throws', async () => {
    await seedEpisode('You loved the ceviche in Lima', '2026-01-10', 4);
    await seedEpisode('You debugged your printer for an hour', '2026-02-10', 8);

    // Force the search request's embed() to fail. The route catches this and
    // falls back to lexical recall (an empty query embedding skips the vector
    // arm in the store) rather than 500-ing.
    ctx.deps.embeddings.embed = async () => {
      throw new Error('embedding provider unavailable');
    };

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: auth,
      payload: { query: 'ceviche' },
    });

    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(1);
    expect(results[0].episode.summary).toContain('ceviche');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('owner-scopes the timeline and search (404 for a non-owner)', async () => {
    await seedEpisode('You loved the ceviche in Lima', '2026-01-10', 4);
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const timeline = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/episodes`,
      headers: otherAuth,
    });
    expect(timeline.statusCode).toBe(404);

    // The search path resolves the companion against the caller's ownership
    // before touching the store, so a non-owner gets a 404 — not the episode.
    const search = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/episodes/search`,
      headers: otherAuth,
      payload: { query: 'ceviche' },
    });
    expect(search.statusCode).toBe(404);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${ABSENT_UUID}/episodes`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });
});
