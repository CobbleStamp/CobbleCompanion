/**
 * Approval-queue routes: list pending, confirm (executes + logs exactly once),
 * reject, tenancy isolation, and the over-cap guard on confirm.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('proposal routes', () => {
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

  /** Enqueue a pending ingest_source proposal directly (the gate is covered in core). */
  async function seedProposal(url = 'https://x.dev/post'): Promise<string> {
    const proposal = await ctx.deps.proposals.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url },
      summary: `Remember ${url}`,
    });
    return proposal.id;
  }

  it('lists the pending approval queue', async () => {
    await seedProposal();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/proposals`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { proposals } = res.json();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].toolName).toBe('ingest_source');
    expect(proposals[0].status).toBe('pending');
  });

  it('confirm executes the held action, logs it, then narrates the outcome (SSE)', async () => {
    const id = await seedProposal();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    // Confirm now RE-ENTERS the loop and streams the companion's narration
    // (the fake gateway scripts "Hi there"), rather than returning the raw line.
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"done"');
    expect(res.body).toContain('Hi there');

    // The action executed: a source + ingestion job now exist.
    const sources = await ctx.deps.semantic.listSources(companionId);
    expect(sources).toHaveLength(1);
    // Every tool call is logged (the DoD).
    const logged = await ctx.deps.toolCallLog.list(companionId, 10);
    expect(logged.map((r) => r.name)).toEqual(['ingest_source']);
    // The queue is now empty.
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
    // The transcript records the approved action (a friendly row that survives
    // reload) followed by the companion's narration.
    const transcript = await ctx.deps.memory.getRecentMessages(companionId, 10);
    const contents = transcript.map((m) => m.content);
    expect(contents.some((c) => /Started reading https:\/\/x\.dev\/post/.test(c))).toBe(true);
    expect(contents).toContain('Hi there');
  });

  it('a second confirm is a no-op (exactly-once) and does not re-execute', async () => {
    const id = await seedProposal();
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    expect(second.statusCode).toBe(409);
    // Only one source was created — no double-execute.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(1);
  });

  it('reject resolves the proposal without executing anything', async () => {
    const id = await seedProposal();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/reject`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
  });

  it("404s when rejecting another owner's companion (tenancy)", async () => {
    const id = await seedProposal();
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/reject`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
    // The proposal is untouched — still pending for its real owner.
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(1);
  });

  it("404s when confirming another owner's companion (tenancy)", async () => {
    const id = await seedProposal();
    const otherAuth = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('429s on confirm when the owner is over their daily token cap', async () => {
    const id = await seedProposal();
    await ctx.deps.quota.recordUsage(await ownerId(ctx), ctx.deps.config.tokenCapPerDay + 1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(429);
  });
});

/** Resolve the owner's user id (the email is JIT-provisioned on first auth). */
async function ownerId(ctx: TestApp): Promise<string> {
  const user = await ctx.deps.identity.ensureUserByEmail('owner@example.com');
  return user.id;
}
