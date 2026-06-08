/**
 * Phase 5 Definition-of-Done — bond & growth, mechanically verified offline
 * (development-plan.md §3). Growth is mechanical (derived from substrate), not a
 * recall-quality score, so the gate is deterministic. It drives the real growth
 * service + feeding economy + routes through the app's stores and asserts:
 *   1. A substrate change → the axis band rises and capabilities are observed,
 *      surfaced via the read-only GET /growth (the visible four axes).
 *   2. Crossing a threshold (on the post-turn recompute, driven here by calling
 *      growth.recompute directly as the message route does inline) posts an
 *      in-character growth note to the transcript (growth, felt).
 *   3. Recompute is idempotent — a repeat recompute never re-posts a note (and the
 *      read-only GET never mutates anything).
 *   4. Feeding consumes a food from the user's pantry and refills the favoured
 *      wallet; out of that food → 409.
 *   5. A learned procedure RESURFACES as a context hint (abilities made functional,
 *      not just observed).
 */

import { createProceduralRetrieveContext, DEFAULT_GROWTH_CONFIG } from '@cobble/core';
import {
  growthReflectionNote,
  type FeedResultDto,
  type FoodInventoryDto,
  type GrowthDto,
} from '@cobble/shared';
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

  /** Drive the post-turn growth recompute the way the message route does (inline). */
  async function runGrowth(): Promise<void> {
    await ctx.deps.growth.recompute(companionId);
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

  it('starts unformed in the empty bands with nothing observed', async () => {
    const growth = await getGrowth();
    expect(growth.knowledge.band).toBe('Sparse');
    expect(growth.bond.band).toBe('New');
    expect(growth.initiative.band).toBe("Hasn't ventured out yet");
    expect(growth.character.band).toBe('Still forming');
    expect(growth.capabilities.every((c) => !c.observed)).toBe(true);
  });

  it('raises the axis + observes capabilities + posts a reflection (DoD 1+2)', async () => {
    await seedSubstrate();
    await runGrowth();
    const growth = await getGrowth();

    // Knowledge axis rose; capabilities observed from real tool/source logs.
    expect(growth.knowledge.band).not.toBe('Sparse');
    expect(growth.capabilities.find((c) => c.key === 'reading_sources')?.observed).toBe(true);
    expect(growth.capabilities.find((c) => c.key === 'web_research')?.observed).toBe(true);
    expect(growth.capabilities.find((c) => c.key === 'memory_recall')?.observed).toBe(true);
    expect(growth.capabilities.find((c) => c.key === 'multi_step_task')?.observed).toBe(true);
    // A growth reflection landed in the transcript (growth, felt).
    const notes = await assistantNotes();
    expect(notes).toContain(growthReflectionNote('knowledge'));
  });

  it('is idempotent — a repeat recompute never re-posts (DoD 3)', async () => {
    await seedSubstrate();
    await runGrowth();
    const first = await getGrowth();
    const notesAfterFirst = (await assistantNotes()).length;

    await runGrowth();
    const second = await getGrowth();
    expect(second.knowledge.band).toBe(first.knowledge.band);
    expect((await assistantNotes()).length).toBe(notesAfterFirst);
  });

  it('GET /growth is read-only — a read never advances the mark or reflects (DoD 3)', async () => {
    // Substrate that crosses a knowledge band + observes capabilities, but NO recompute.
    await seedSubstrate();

    // The surface shows the live derived reading (it rose)...
    const first = await getGrowth();
    expect(first.knowledge.band).not.toBe('Sparse');
    expect(first.capabilities.find((c) => c.key === 'reading_sources')?.observed).toBe(true);

    // ...yet repeated reads post no reflection — that side effect is recompute's
    // (the stream tail) alone, never a GET's.
    await getGrowth();
    expect(await assistantNotes()).not.toContain(growthReflectionNote('knowledge'));

    // And the stored high-water mark is untouched: a GET never writes the mark, even
    // when the live reading has already moved past it.
    const mark = await ctx.deps.growthStore.getSnapshot(companionId);
    expect(mark.knowledgeBand).toBe(0);
    expect(mark.observedCapabilities).toEqual([]);
  });

  it('feeds: consumes a food from the pantry and refills the energy wallet (DoD 4)', async () => {
    const before = await ctx.deps.energy.getBalance(companionId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/feed`,
      headers: auth,
      payload: { food: 'spark' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FeedResultDto;
    expect(body.budget.energy.balanceTokens).toBeGreaterThan(before);
    expect(body.food.spark).toBe(DEFAULT_GROWTH_CONFIG.initialFood - 1);
  });

  it('refuses to feed once that food runs out (DoD 4)', async () => {
    // Drain the user's whole ration supply (each feed consumes one).
    for (let i = 0; i < DEFAULT_GROWTH_CONFIG.initialFood; i += 1) {
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

  it('GET /food returns the user pantry (DoD 4)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/food', headers: auth });
    expect(res.statusCode).toBe(200);
    const { food } = res.json() as { food: FoodInventoryDto };
    expect(food.ration).toBe(DEFAULT_GROWTH_CONFIG.initialFood);
    expect(food.spark).toBe(DEFAULT_GROWTH_CONFIG.initialFood);
    expect(food.treat).toBe(DEFAULT_GROWTH_CONFIG.initialFood);
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
