/**
 * Phase 5 Definition-of-Done — bond & growth, mechanically verified offline
 * (development-plan.md §3). Growth is mechanical (derived from substrate), not a
 * recall-quality score, so the gate is deterministic. It drives the real growth
 * service + feeding economy + routes through the app's stores and asserts:
 *   1. A substrate change → the axis level rises and abilities unlock, surfaced
 *      via GET /growth (the visible four axes).
 *   2. Crossing a threshold awards treats AND posts an in-character growth note to
 *      the transcript (growth, felt).
 *   3. Recompute is idempotent — re-reading growth never double-awards treats or
 *      re-posts a note.
 *   4. Feeding spends treats and tops up the favoured pool; out of treats → 409.
 *   5. A learned procedure RESURFACES as a context hint (abilities made functional,
 *      not just observed).
 */

import { createProceduralRetrieveContext, DEFAULT_GROWTH_CONFIG } from '@cobble/core';
import type { GrowthDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, silentLogger, type TestApp } from '../test/helpers.js';

describe('Phase 5 DoD — bond & growth', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
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

  async function getGrowth(): Promise<GrowthDto> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${companionId}/growth`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as GrowthDto;
  }

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await ctx.deps.memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  /** Seed enough substrate to cross a knowledge level and unlock several abilities. */
  async function seedSubstrate(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await ctx.deps.semantic.createSource(companionId, {
        kind: 'note',
        title: `note ${i}`,
        rawText: 'hello world',
      });
    }
    await ctx.deps.toolCallLog.record(companionId, 'web_fetch', {}, 'ok');
    await ctx.deps.toolCallLog.record(companionId, 'memory_search', {}, 'ok');
  }

  it('starts unformed at stage 0 with all abilities locked', async () => {
    const growth = await getGrowth();
    expect(growth.overallStage).toBe(0);
    expect(growth.emoji).toBe(DEFAULT_GROWTH_CONFIG.stageEmoji[0]);
    expect(growth.treats).toBe(DEFAULT_GROWTH_CONFIG.initialTreats);
    expect(growth.abilities.every((a) => !a.unlocked)).toBe(true);
    expect(growth.personality.spread).toBe(0);
  });

  it('raises the axis + unlocks abilities + awards treats + posts a note (DoD 1+2)', async () => {
    await seedSubstrate();
    const growth = await getGrowth();

    // Knowledge axis rose; abilities unlocked from real tool/source logs.
    expect(growth.knowledge.level).toBeGreaterThanOrEqual(1);
    expect(growth.abilities.find((a) => a.key === 'reading_sources')?.unlocked).toBe(true);
    expect(growth.abilities.find((a) => a.key === 'web_research')?.unlocked).toBe(true);
    expect(growth.abilities.find((a) => a.key === 'memory_recall')?.unlocked).toBe(true);
    expect(growth.abilities.find((a) => a.key === 'multi_step_task')?.unlocked).toBe(true);
    // Treats were earned beyond the starting balance.
    expect(growth.treats).toBeGreaterThan(DEFAULT_GROWTH_CONFIG.initialTreats);
    // A growth note landed in the transcript (growth, felt).
    const notes = await assistantNotes();
    expect(notes.some((n) => n.includes('Knowledge') || n.includes('learned'))).toBe(true);
  });

  it('is idempotent — re-reading growth never double-awards or re-posts (DoD 3)', async () => {
    await seedSubstrate();
    const first = await getGrowth();
    const notesAfterFirst = (await assistantNotes()).length;

    const second = await getGrowth();
    expect(second.treats).toBe(first.treats);
    expect(second.knowledge.level).toBe(first.knowledge.level);
    expect((await assistantNotes()).length).toBe(notesAfterFirst);
  });

  it('feeds: spends a treat and tops up the energy pool (DoD 4)', async () => {
    const before = await ctx.deps.energy.getEnergy(companionId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/feed`,
      headers: auth,
      payload: { food: 'spark' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { budget: { energy: { capTokens: number } }; growth: GrowthDto };
    expect(body.budget.energy.capTokens).toBeGreaterThan(before.capTokens);
    expect(body.growth.treats).toBe(DEFAULT_GROWTH_CONFIG.initialTreats - 1);
  });

  it('refuses to feed once treats run out (DoD 4)', async () => {
    // Spend the whole starting balance (each food costs one treat).
    for (let i = 0; i < DEFAULT_GROWTH_CONFIG.initialTreats; i += 1) {
      const ok = await ctx.app.inject({
        method: 'POST',
        url: `/companions/${companionId}/feed`,
        headers: auth,
        payload: { food: 'ration' },
      });
      expect(ok.statusCode).toBe(200);
    }
    const broke = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/feed`,
      headers: auth,
      payload: { food: 'ration' },
    });
    expect(broke.statusCode).toBe(409);
  });

  it('rejects a bad food and a missing companion', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/feed`,
      headers: auth,
      payload: { food: 'pizza' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/companions/${crypto.randomUUID()}/growth`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('resurfaces a learned procedure as a context hint (DoD 5 — abilities made functional)', async () => {
    await ctx.deps.procedural.record(companionId, 'book a hotel', ['web_fetch', 'ingest_source']);
    const arm = createProceduralRetrieveContext({
      procedural: ctx.deps.procedural,
      logger: silentLogger,
    });
    const result = await arm({ companionId, userContent: 'can you book a hotel for Friday?' });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.content).toContain('book a hotel');
  });
});
