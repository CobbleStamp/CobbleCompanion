import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('user-model routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let userId: string;
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(['Hi', ' there']);
    auth = ctx.bearerFor('owner@example.com');
    const user = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
    userId = user.id;
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

  function recordName(object: string): Promise<{ id: string }> {
    return ctx.deps.userModel.recordTranscriptFact({
      userId,
      predicate: 'name',
      object,
      learnedByCompanionId: companionId,
      confidence: 0.9,
    });
  }

  it('GET /user/facts returns the current facts', async () => {
    await recordName('Sam');
    const res = await ctx.app.inject({ method: 'GET', url: '/user/facts', headers: auth });
    expect(res.statusCode).toBe(200);
    const { facts } = res.json();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ predicate: 'name', object: 'Sam', source: 'transcript' });
  });

  it('GET /user/facts partitions Tier-1 facts from Tier-2 beliefs (Phase 12)', async () => {
    await recordName('Sam');
    await ctx.deps.userModel.recordBelief({ userId, predicate: 'interestedIn', object: 'jazz' });
    const res = await ctx.app.inject({ method: 'GET', url: '/user/facts', headers: auth });
    const { facts, beliefs } = res.json();
    expect(facts.map((f: { predicate: string }) => f.predicate)).toEqual(['name']);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({ predicate: 'interestedIn', object: 'jazz' });
  });

  it('GET /user/facts requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/user/facts' });
    expect(res.statusCode).toBe(401);
  });

  it('PATCH edits a fact to an authoritative user_edit value', async () => {
    const fact = await recordName('Sam');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/user/facts/${fact.id}`,
      headers: auth,
      payload: { object: 'Samuel' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ object: 'Samuel', source: 'user_edit' });
    const after = await ctx.deps.userModel.listCurrent(userId);
    expect(after[0]?.object).toBe('Samuel');
  });

  it('DELETE forgets a fact so it leaves the current set', async () => {
    const fact = await recordName('Sam');
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/user/facts/${fact.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(await ctx.deps.userModel.listCurrent(userId)).toHaveLength(0);
  });

  it("404s editing/forgetting another user's fact (tenancy)", async () => {
    const fact = await recordName('Sam');
    const otherAuth = ctx.bearerFor('intruder@example.com');
    await ctx.deps.identity.ensureUserByEmail('intruder@example.com');
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/user/facts/${fact.id}`,
      headers: otherAuth,
      payload: { object: 'Hacked' },
    });
    expect(patched.statusCode).toBe(404);
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/user/facts/${fact.id}`,
      headers: otherAuth,
    });
    expect(deleted.statusCode).toBe(404);
    // The owner's fact is untouched.
    expect((await ctx.deps.userModel.listCurrent(userId))[0]?.object).toBe('Sam');
  });

  it('edits a Tier-2 belief (re-embedded) and deletes it (Phase 13 — full management)', async () => {
    const belief = await ctx.deps.userModel.recordBelief({
      userId,
      predicate: 'interestedIn',
      object: 'jazz',
    });
    // Edit: a belief is now correctable via the API; the route re-embeds the new value.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/user/facts/${belief.id}`,
      headers: auth,
      payload: { object: 'techno' },
    });
    expect(patched.statusCode).toBe(200);
    expect(await ctx.deps.userModel.listCurrentBeliefs(userId)).toMatchObject([
      { object: 'techno' },
    ]);
    // Delete: the explicit forget / sensitive purge removes the belief outright.
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/user/facts/${belief.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);
    expect(await ctx.deps.userModel.listCurrentBeliefs(userId)).toHaveLength(0);
  });

  it('404s an unknown fact and 400s an invalid body', async () => {
    const unknown = await ctx.app.inject({
      method: 'PATCH',
      url: `/user/facts/${ABSENT_UUID}`,
      headers: auth,
      payload: { object: 'X' },
    });
    expect(unknown.statusCode).toBe(404);
    const fact = await recordName('Sam');
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/user/facts/${fact.id}`,
      headers: auth,
      payload: { object: '   ' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('404s a malformed (non-UUID) factId before the DB', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/user/facts/not-a-uuid',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
