/**
 * Phase 3 Definition-of-Done, end to end (offline, deterministic). Drives a
 * multi-step tool task through the real harness + gate + stores: the companion
 * reads (read-only tool, runs freely), then wants to remember something
 * (effectful tool) — which is HELD for approval. Asserts nothing consequential
 * executed without confirmation, every tool call was logged, and approval then
 * executes the action and seeds a procedural memory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';
import type { ChatStreamEvent } from '@cobble/shared';

/** A scripted run: turn 1 searches memory (read-only), turn 2 proposes ingesting. */
const TURNS = [
  { chunks: ['Let me check what I already know. '], toolCalls: [{ id: 't1', name: 'memory_search', args: { query: 'peru food' } }] },
  { chunks: ['That looks worth keeping. '], toolCalls: [{ id: 't2', name: 'ingest_source', args: { url: 'https://x.dev/peru' } }] },
];

async function streamEvents(ctx: TestApp, companionId: string, auth: { authorization: string }) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/companions/${companionId}/messages`,
    headers: auth,
    payload: { content: 'Research Peruvian food and remember the best source.' },
  });
  return res.payload
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice('data:'.length).trim()) as ChatStreamEvent);
}

describe('Phase 3 DoD — multi-step task ends in a held proposal', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(TURNS);
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

  it('runs the read tool, holds the effectful action, executes nothing until approved', async () => {
    const events = await streamEvents(ctx, companionId, auth);

    // The turn EXITed proposing the effectful action.
    const proposalEvent = events.find((e) => e.type === 'proposal');
    expect(proposalEvent && proposalEvent.type === 'proposal' && proposalEvent.proposal.toolName).toBe(
      'ingest_source',
    );

    // Nothing consequential executed: no source ingested, the action is pending.
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(0);
    const pending = await ctx.deps.proposals.listPending(companionId);
    expect(pending).toHaveLength(1);

    // Every tool call so far is logged — and only the read-only one ran.
    const logged = await ctx.deps.toolCallLog.list(companionId, 10);
    expect(logged.map((r) => r.name)).toEqual(['memory_search']);

    // Approve it → the action executes once, is logged, and seeds a procedure.
    const confirm = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${pending[0]!.id}/confirm`,
      headers: auth,
    });
    expect(confirm.statusCode).toBe(200);
    expect(await ctx.deps.semantic.listSources(companionId)).toHaveLength(1);
    const afterApproval = await ctx.deps.toolCallLog.list(companionId, 10);
    expect(afterApproval.map((r) => r.name)).toContain('ingest_source');
    expect(await ctx.deps.procedural.count(companionId)).toBe(1);
  });
});
