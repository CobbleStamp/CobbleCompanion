/**
 * Greeting on arrival (Phase 14) — the DoD, end-to-end through the real app:
 * a first meeting introduces itself (even at `off`); a return after a gap greets
 * (spending stamina, recording a bond outcome, stamping the arrival clock); a
 * brief tab-away and an `off` dial stay silent; an exhausted companion shows the
 * fixed token-free line; and a greeting never stacks on a pending outcome.
 */

import type { ChatStreamEvent } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

/** Parse the buffered SSE body into its events (mirrors the client's `readSse`). */
function parseSse(body: string): ChatStreamEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as ChatStreamEvent);
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('greeting routes', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp(['Hello', ' again']);
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

  const greet = () =>
    ctx.app.inject({ method: 'POST', url: `/companions/${companionId}/greeting`, headers: auth });

  it('introduces itself on a first meeting — even at dial=off', async () => {
    await ctx.deps.identity.setProactivityDial(companionId, 'off');
    const res = await greet();
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(['composing', 'done']);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.message.role).toBe('assistant');
      expect(done.message.content).toContain('Hello again');
    }
    // The arrival clock is now stamped, so the companion is no longer "never seen".
    const record = await ctx.deps.identity.getCompanionById(companionId);
    expect(record?.lastSeenAt).not.toBeNull();
  });

  it('greets on a return after a real gap: spends stamina, records a bond outcome', async () => {
    await ctx.deps.identity.setProactivityDial(companionId, 'active');
    await ctx.deps.identity.markSeen(companionId, new Date(Date.now() - 3 * HOUR));
    const before = await ctx.deps.quota.getBalance(companionId);

    const res = await greet();
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(['composing', 'done']);

    // Voiced greeting is billed to STAMINA (the quota wallet), not energy.
    expect(await ctx.deps.quota.getBalance(companionId)).toBeLessThan(before);
    expect(await ctx.deps.energy.getBalance(companionId)).toBe(
      ctx.deps.config.startingVitalityTokens,
    );
    // A pending bond outcome was recorded so the reaction can reinforce it.
    const outcome = await ctx.deps.rewards.findLatestUnresolved(companionId);
    expect(outcome?.drive).toBe('bond');
  });

  it('stays silent on a brief tab-away (below the continuation floor)', async () => {
    await ctx.deps.identity.setProactivityDial(companionId, 'active');
    await ctx.deps.identity.markSeen(companionId, new Date(Date.now() - 5 * 60_000));
    const res = await greet();
    expect(res.statusCode).toBe(200);
    expect(parseSse(res.body)).toHaveLength(0);
  });

  it('stays silent at dial=off after the first meeting', async () => {
    await ctx.deps.identity.setProactivityDial(companionId, 'off');
    await ctx.deps.identity.markSeen(companionId, new Date(Date.now() - 2 * DAY));
    expect(parseSse((await greet()).body)).toHaveLength(0);
  });

  it('picks up a pending approval as the open loop (gentle + short gap)', async () => {
    // Default dial is gentle; a 90-min gap is short of a day, so only an open loop
    // makes it greet — proving the approval queue is what surfaces it.
    await ctx.deps.identity.markSeen(companionId, new Date(Date.now() - 90 * 60_000));
    await ctx.deps.proposals.create(companionId, {
      toolName: 'ingest_source',
      toolArgs: { url: 'https://example.com' },
      summary: 'read example.com into memory',
    });
    const events = parseSse((await greet()).body);
    expect(events.map((e) => e.type)).toEqual(['composing', 'done']);
  });

  it('shows the fixed exhausted line (no outcome) when stamina is empty', async () => {
    await ctx.deps.identity.setProactivityDial(companionId, 'active');
    await ctx.deps.identity.markSeen(companionId, new Date(Date.now() - 3 * HOUR));
    await ctx.deps.quota.spend(companionId, ctx.deps.config.startingVitalityTokens);

    const events = parseSse((await greet()).body);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.message.content).toContain('Feed me');
    // The exhausted groan is not a drive-serving act — no reward outcome recorded.
    expect(await ctx.deps.rewards.findLatestUnresolved(companionId)).toBeNull();
  });

  it('on a voicing failure: emits a generic error, persists no turn, records no outcome', async () => {
    // A separate app whose lone scripted LLM turn yields nothing, so the voicing
    // comes back empty — standing in for any transient generation failure.
    const broken = await makeTestApp(['']);
    try {
      const brokenAuth = broken.bearerFor('owner@example.com');
      const created = await broken.app.inject({
        method: 'POST',
        url: '/companions',
        headers: brokenAuth,
        payload: { name: 'Pebble', form: 'fox', temperament: 'curious' },
      });
      const id = created.json().companion.id;
      await broken.deps.identity.setProactivityDial(id, 'active');
      await broken.deps.identity.markSeen(id, new Date(Date.now() - 3 * HOUR));

      const res = await broken.app.inject({
        method: 'POST',
        url: `/companions/${id}/greeting`,
        headers: brokenAuth,
      });
      const events = parseSse(res.body);
      // The failure is honest: composing → error, never a (fake) greeting.
      expect(events.map((e) => e.type)).toEqual(['composing', 'error']);
      const err = events.find((e) => e.type === 'error');
      // Never the misleading "I'm worn out, feed me" line on a healthy companion.
      expect(err?.type === 'error' && err.message).not.toContain('Feed me');
      // No turn was written to the transcript...
      expect(await broken.deps.memory.getRecentMessages(id, 5)).toHaveLength(0);
      // ...and no reward was attributed to the failed generation.
      expect(await broken.deps.rewards.findLatestUnresolved(id)).toBeNull();
      // The arrival clock is still stamped (finally), so it won't re-fire forever.
      expect((await broken.deps.identity.getCompanionById(id))?.lastSeenAt).not.toBeNull();
    } finally {
      await broken.close();
    }
  });

  it('does not stack a greeting on a note still awaiting a reaction', async () => {
    await ctx.deps.identity.setProactivityDial(companionId, 'active');
    await ctx.deps.identity.markSeen(companionId, new Date(Date.now() - 3 * HOUR));
    await ctx.deps.rewards.record(companionId, { drive: 'curiosity' });
    expect(parseSse((await greet()).body)).toHaveLength(0);
  });

  it('404s for a companion the caller does not own', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/greeting`,
      headers: ctx.bearerFor('intruder@example.com'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/greeting`,
    });
    expect(res.statusCode).toBe(401);
  });
});
