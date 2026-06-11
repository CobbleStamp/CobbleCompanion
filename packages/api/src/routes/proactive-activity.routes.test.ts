/**
 * Autonomous-activity route (Phase 4): the read-only `proactive_outcomes` log —
 * shape, the joined report note + belief, keyset pagination, and owner isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProactiveActivityDto } from '@cobble/shared';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('proactive-activity routes', () => {
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

  /** Seed one autonomous outcome: a report note + a recorded proactive_outcomes row. */
  async function seedOutcome(
    note: string,
    drive: 'curiosity' | 'bond' = 'curiosity',
  ): Promise<void> {
    const message = await ctx.deps.memory.appendMessage(companionId, 'assistant', note);
    await ctx.deps.rewards.record(companionId, { noteMessageId: message.id, drive });
  }

  it('returns an empty log with zero stats for a fresh companion', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/activity`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProactiveActivityDto;
    expect(body.outcomes).toEqual([]);
    expect(body.stats).toEqual({ total: 0, positive: 0 });
    expect(body.nextCursor).toBeNull();
  });

  it('lists outcomes newest-first with the joined note and pending reaction', async () => {
    await seedOutcome('I read about foxes.', 'curiosity');
    await seedOutcome('I checked in on you.', 'bond');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/activity`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProactiveActivityDto;
    expect(body.outcomes).toHaveLength(2);
    expect(body.outcomes[0]!.drive).toBe('bond'); // newest first
    expect(body.outcomes[0]!.note).toBe('I checked in on you.');
    expect(body.outcomes[0]!.resolved).toBe(false);
    expect(body.outcomes[0]!.reward).toBeNull();
    expect(body.stats.total).toBe(2);
  });

  it('paginates with limit + the before cursor', async () => {
    await seedOutcome('one');
    await seedOutcome('two');
    await seedOutcome('three');

    const first = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/activity?limit=2`,
      headers: auth,
    });
    const firstBody = first.json() as ProactiveActivityDto;
    expect(firstBody.outcomes.map((o) => o.note)).toEqual(['three', 'two']);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/activity?limit=2&before=${firstBody.nextCursor}`,
      headers: auth,
    });
    const secondBody = second.json() as ProactiveActivityDto;
    expect(secondBody.outcomes.map((o) => o.note)).toEqual(['one']);
    expect(secondBody.nextCursor).toBeNull(); // exhausted
  });

  it('surfaces the sources an act read with the findings each yielded', async () => {
    const source = await ctx.deps.semantic.createSource(companionId, {
      kind: 'link',
      title: 'https://ex.com/cpi',
      origin: 'https://ex.com/cpi',
      rawText: 'x',
    });
    await ctx.deps.semantic.insertSections(companionId, source.id, [
      { topicTitle: 'Risk Disclaimer', originalText: '…', paraStart: 0, paraEnd: 1, ord: 0 },
    ]);
    const message = await ctx.deps.memory.appendMessage(companionId, 'assistant', 'I read it.');
    await ctx.deps.rewards.record(companionId, {
      noteMessageId: message.id,
      drive: 'curiosity',
      readSources: [{ sourceId: source.id, title: 'https://ex.com/cpi' }],
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/activity`,
      headers: auth,
    });
    const body = res.json() as ProactiveActivityDto;
    expect(body.outcomes[0]!.sources).toHaveLength(1);
    expect(body.outcomes[0]!.sources[0]!.title).toBe('https://ex.com/cpi');
    expect(body.outcomes[0]!.sources[0]!.findings).toEqual(['Risk Disclaimer']);
  });

  it('404s for a companion the caller does not own', async () => {
    const intruder = ctx.bearerFor('intruder@example.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/activity`,
      headers: intruder,
    });
    expect(res.statusCode).toBe(404);
  });
});
