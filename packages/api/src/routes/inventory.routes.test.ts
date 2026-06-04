/** Reading-list (leads), explore (propose-from-leads), and procedures routes. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('inventory routes', () => {
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

  it('lists the reading list (new + read leads)', async () => {
    await ctx.deps.leads.record(companionId, 'https://a.dev', 'found while reading X');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/leads`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().leads).toMatchObject([{ url: 'https://a.dev', status: 'new' }]);
  });

  it('explore proposes remembering the next leads and marks them read', async () => {
    await ctx.deps.leads.record(companionId, 'https://a.dev');
    await ctx.deps.leads.record(companionId, 'https://b.dev');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { proposals } = res.json();
    expect(proposals).toHaveLength(2);
    expect(proposals[0].toolName).toBe('ingest_source');

    // The proposals are now pending in the approval queue.
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(2);
    // The leads were advanced to 'read' (no longer 'new').
    expect(await ctx.deps.leads.listByStatus(companionId, ['new'])).toHaveLength(0);
    // Nothing was ingested — they only execute on approval.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
  });

  it('explore proposes at most EXPLORE_BURST (3) leads, leaving the rest new', async () => {
    for (const url of ['https://a.dev', 'https://b.dev', 'https://c.dev', 'https://d.dev']) {
      await ctx.deps.leads.record(companionId, url);
    }

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    // Only the bounded burst is proposed/advanced — the 4th lead stays unread.
    expect(res.json().proposals).toHaveLength(3);
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(3);
    expect(await ctx.deps.leads.listByStatus(companionId, ['new'])).toHaveLength(1);
  });

  it('repeated explore advances through the list without re-proposing read leads', async () => {
    for (const url of ['https://a.dev', 'https://b.dev', 'https://c.dev', 'https://d.dev']) {
      await ctx.deps.leads.record(companionId, url);
    }

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: auth,
    });
    expect(first.json().proposals).toHaveLength(3);

    // The next explore takes the remaining new lead only — no double-proposing.
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: auth,
    });
    expect(second.json().proposals).toHaveLength(1);
    expect(await ctx.deps.leads.listByStatus(companionId, ['new'])).toHaveLength(0);
    // Four distinct proposals total — every lead proposed exactly once.
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(4);

    // A further explore with nothing new proposes nothing (idempotent tail).
    const third = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: auth,
    });
    expect(third.json().proposals).toHaveLength(0);
  });

  it('404s when another owner triggers explore (tenancy)', async () => {
    await ctx.deps.leads.record(companionId, 'https://a.dev');
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
    // Nothing was proposed or advanced for the intruder's request.
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
    expect(await ctx.deps.leads.listByStatus(companionId, ['new'])).toHaveLength(1);
  });

  it('404s when another owner lists procedures (tenancy)', async () => {
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/procedures`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists learned procedures (recorded after an approved action)', async () => {
    await ctx.deps.procedural.record(companionId, 'Remember a.dev', ['ingest_source']);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/procedures`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().procedures).toMatchObject([
      { title: 'Remember a.dev', steps: ['ingest_source'] },
    ]);
  });

  it("404s for another owner's companion (tenancy)", async () => {
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/leads`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
  });
});
