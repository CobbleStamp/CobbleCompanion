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

  /**
   * Enqueue a pending proposal the way `explore` does — from a reading-list lead,
   * so the proposal carries its `leadId`. Returns both ids so a test can confirm
   * /reject the proposal and then assert the lead's resulting lifecycle status.
   */
  async function seedExploreProposal(
    url = 'https://x.dev/post',
  ): Promise<{ proposalId: string; leadId: string }> {
    await ctx.deps.leads.record(companionId, url);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/explore`,
      headers: auth,
    });
    const [lead] = await ctx.deps.leads.listByStatus(companionId, ['read']);
    return { proposalId: res.json().proposals[0].id, leadId: lead!.id };
  }

  /** The status a lead currently holds, or undefined if it left every list. */
  async function leadStatus(leadId: string): Promise<string | undefined> {
    const all = await ctx.deps.leads.listByStatus(companionId, [
      'new',
      'read',
      'ingested',
      'discarded',
    ]);
    return all.find((l) => l.id === leadId)?.status;
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
    // A successful approved action seeds a procedural memory (the learned workflow).
    expect(await ctx.deps.procedural.count(companionId)).toBe(1);
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

  it('confirm of an AUTONOMOUS proposal does NOT re-enter the loop; it nudges the engine', async () => {
    // A self-directed (motivation-engine) proposal: confirming it executes the
    // action but must not start an LLM narration turn — deciding what's next is
    // the engine's job (architecture.md §4.4/§4.5).
    await ctx.deps.leads.record(companionId, 'https://auto.dev');
    const [lead] = await ctx.deps.leads.listByStatus(companionId, ['new']);
    const proposal = await ctx.deps.proposals.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://auto.dev' },
      summary: 'Remember https://auto.dev',
      leadId: lead!.id,
      origin: 'autonomous',
    });
    // Capture the engine nudge (override the shared runner instance, test-only).
    const requested: string[] = [];
    ctx.deps.motivation.request = (id: string): void => {
      requested.push(id);
    };

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${proposal.id}/confirm`,
      headers: auth,
    });

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"done"');
    // No LLM continuation: the scripted narration "Hi there" must NOT appear.
    expect(res.body).not.toContain('Hi there');
    // The action still executed and the lead reached its terminal state.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(1);
    expect(await leadStatus(lead!.id)).toBe('ingested');
    // The engine was nudged to decide the next move.
    expect(requested).toContain(companionId);
    // And no narration row was written to the transcript.
    const transcript = await ctx.deps.memory.getRecentMessages(companionId, 10);
    expect(transcript.map((m) => m.content)).not.toContain('Hi there');
  });

  it('does not seed procedural memory when the approved action fails', async () => {
    // A proposal whose held call fails as data (bad url → ingest_source refuses).
    // The user approved it, but the action never happened — so no "learned
    // workflow" should be recorded (it would teach a procedure for a no-op).
    const id = await seedProposal('not-a-url');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    // Confirm still resolves and narrates the (failed) outcome.
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Nothing was ingested, and crucially no procedural memory was seeded.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
    expect(await ctx.deps.procedural.count(companionId)).toBe(0);
    // The failure is still logged as a tool call (the DoD: every call is logged).
    const logged = await ctx.deps.toolCallLog.list(companionId, 10);
    expect(logged.map((r) => r.name)).toEqual(['ingest_source']);
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

  it('confirm advances the originating lead to ingested (it leaves the reading list — M2)', async () => {
    const { proposalId, leadId } = await seedExploreProposal();
    // Before confirm the lead is parked at 'read' (explore advanced it there).
    expect(await leadStatus(leadId)).toBe('read');

    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${proposalId}/confirm`,
      headers: auth,
    });

    // The successfully-ingested lead reaches its terminal state and is gone from
    // the reading-list view (GET /leads lists only new + read).
    expect(await leadStatus(leadId)).toBe('ingested');
    expect(await ctx.deps.leads.listByStatus(companionId, ['new', 'read'])).toHaveLength(0);
  });

  it('confirm of a FAILED ingest leaves the lead at read, not ingested', async () => {
    // The held call fails as data (bad url), so the lead was never read into
    // memory — it must not be marked 'ingested' (only a real success counts).
    const { proposalId, leadId } = await seedExploreProposal('not-a-url');
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${proposalId}/confirm`,
      headers: auth,
    });
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
    expect(await leadStatus(leadId)).toBe('read');
  });

  it('reject advances the originating lead to discarded (never re-proposed — M2)', async () => {
    const { proposalId, leadId } = await seedExploreProposal();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${proposalId}/reject`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);

    // The declined lead reaches 'discarded': out of the reading list, and a
    // further explore (which pulls only 'new') will never re-propose it.
    expect(await leadStatus(leadId)).toBe('discarded');
    expect(await ctx.deps.leads.listByStatus(companionId, ['new', 'read'])).toHaveLength(0);
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

  it('rejecting then confirming the same proposal 409s and never executes the held action', async () => {
    // The atomic claim guards on status='pending': once a proposal is rejected it
    // is no longer pending, so a later confirm cannot win the transition — and so
    // the held ingest must not run (no source, no proposal re-execution).
    const id = await seedProposal();
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/reject`,
      headers: auth,
    });
    expect(rejected.statusCode).toBe(204);

    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    expect(confirmed.statusCode).toBe(409);
    // The held action never ran: nothing ingested, nothing logged.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
    expect(await ctx.deps.toolCallLog.list(companionId, 10)).toHaveLength(0);
  });

  it('confirming then rejecting the same proposal 409s (the reverse cross-transition)', async () => {
    // Confirm flips pending→approved; a later reject can no longer win the
    // pending-gated transition, so it 409s — the action stays exactly-once.
    const id = await seedProposal();
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/reject`,
      headers: auth,
    });
    expect(rejected.statusCode).toBe(409);
    // The confirm executed exactly once — the reject did not undo or re-run it.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(1);
  });

  it('a best-effort audit-log failure does NOT fail an approved action', async () => {
    // logging.md guarantee: a logging hiccup must never fail an action the user
    // already approved. Inject a tool-call-log whose record() throws, then confirm
    // a valid pending proposal — the held ingest must STILL run and the response
    // must still be a successful narration stream.
    const id = await seedProposal();
    // The route captured this exact store instance at registration; overriding the
    // method on the shared instance makes its record() throw (test-only seam — no
    // source change). Restored in the afterEach via a fresh app per test.
    ctx.deps.toolCallLog.record = async (): Promise<void> => {
      throw new Error('audit log is down');
    };

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    // The action still succeeded and the companion still narrated the outcome.
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"done"');
    expect(res.body).toContain('Hi there');
    // The held ingest ran despite the logging failure.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(1);
    // The proposal is resolved (out of the pending queue), not stuck.
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
  });

  it('a best-effort procedural-seed failure does NOT fail an approved action', async () => {
    // The same logging.md guarantee for the procedural-memory seed: if recording
    // the learned workflow throws, the approved action still completes and narrates.
    const id = await seedProposal();
    ctx.deps.procedural.record = async (): Promise<void> => {
      throw new Error('procedural store is down');
    };

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${id}/confirm`,
      headers: auth,
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"done"');
    // The held ingest ran despite the procedural-seed failure.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(1);
    // And the call was still logged (that path is independent of the seed).
    const logged = await ctx.deps.toolCallLog.list(companionId, 10);
    expect(logged.map((r) => r.name)).toEqual(['ingest_source']);
  });

  it('404s a malformed (non-UUID) proposalId before it reaches the DB (review M4)', async () => {
    // The global UUID param guard rejects a malformed resource id with a clean 404
    // rather than letting Postgres throw 22P02 and surface a 500. Nothing executes.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/not-a-uuid/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
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
