/**
 * Phase 4.2 Definition-of-Done — the differentiator, mechanically verified
 * offline (development-plan.md §3). Drives the real motivation engine + the agent
 * loop through the app's stores and asserts:
 *   1. Open the app with no prompt → Cobble READS its reading list on its own
 *      (no approval) and posts one in-character report note.
 *   2. Energy is consumed by the self-initiated work.
 *   3. Out of energy → no initiation and no further spend (chat still runs on stamina).
 *   4. Dial off → no initiation.
 *   5. The CHANGE in the user's mood (sensed in the agent loop) across the
 *      reaction to the report note shifts the served drive's weight — no button,
 *      no separate critic; the harness reads the mood every turn (Phase 4.2).
 *
 * Deterministic: a fake pipeline (a real read needs the network + scripted LLM
 * passes) that bills the energy meter and marks the job done, the in-memory
 * store, neutral weights + the default gentle dial, and a directly-awaited engine
 * tick (request → whenIdle). The scripted LLM turns are consumed strictly in
 * order — see the per-test call sequence in DoD 5.
 */

import type { IngestionRunParams, IngestionTarget } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

const TOKENS_PER_READ = 120;

/** Fake pipeline: simulate a successful read — bill the energy meter, job done. */
function fakeReadPipeline(markDone: (jobId: string) => Promise<void>): IngestionTarget {
  return {
    async run(params: IngestionRunParams): Promise<void> {
      if (params.meter) {
        await params.meter.quota.recordUsage(params.meter.accountId, TOKENS_PER_READ);
      }
      await markDone(params.jobId);
    },
  };
}

describe('Phase 4.2 DoD — proactivity engine', () => {
  let ctx: TestApp;
  let auth: { authorization: string };
  let companionId: string;

  beforeEach(async () => {
    // Scripted LLM turns, consumed strictly in order. DoD 1–4 only ever reach the
    // first turn (the report note). DoD 5 ticks first (turn 0 = the note), then
    // the reaction turn streams a reply (turn 1) + the affect read (turn 2).
    ctx = await makeTestApp(
      [
        { chunks: ['I read some things.'] },
        { chunks: ['Glad it helped!'] },
        { toolCalls: [{ name: 'report_affect', args: { valence: 0.9, note: 'delighted' } }] },
      ],
      undefined,
      {
        motivationPipeline: fakeReadPipeline((jobId) =>
          // Mark the job done so the burst counts it as a successful read.
          ctxDeps().semantic.updateJob(jobId, { status: 'done' }),
        ),
      },
    );
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

  // `ctx` isn't assigned yet when the pipeline closure is built, so reach it lazily.
  function ctxDeps(): TestApp['deps'] {
    return ctx.deps;
  }

  /** Drive one proactive tick to completion (deterministic). */
  async function tick(): Promise<void> {
    ctx.deps.motivation.request(companionId);
    await ctx.deps.motivation.whenIdle();
  }

  async function seedLeads(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await ctx.deps.leads.record(companionId, `https://lead-${i}.dev`);
    }
  }

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await ctx.deps.memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  it('reads the list with no prompt and posts one report note, consuming energy (DoD 1+2)', async () => {
    await seedLeads(5);
    await tick();

    // It read on its own — leads advanced to ingested, no approval queue used.
    expect((await ctx.deps.leads.listByStatus(companionId, ['ingested'])).length).toBeGreaterThan(
      0,
    );
    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
    // Exactly one in-character report note (the reward surface).
    expect(await assistantNotes()).toHaveLength(1);
    // A pending outcome links to that note; energy was consumed.
    const outcomes = await ctx.deps.rewards.list(companionId, 10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.noteMessageId).not.toBeNull();
    expect((await ctx.deps.energy.getEnergy(companionId)).usedTokens).toBeGreaterThan(0);
  });

  it('stops initiating when out of energy, with no further spend (DoD 3)', async () => {
    await seedLeads(5);
    await ctx.deps.energy.recordSpend(companionId, ctx.deps.config.tokenCapPerDay); // exhaust
    const before = (await ctx.deps.energy.getEnergy(companionId)).usedTokens;

    await tick();

    expect(await assistantNotes()).toHaveLength(0);
    expect(await ctx.deps.leads.listByStatus(companionId, ['new'])).toHaveLength(5);
    expect((await ctx.deps.energy.getEnergy(companionId)).usedTokens).toBe(before);
  });

  it('does not initiate when the dial is off (DoD 4)', async () => {
    await seedLeads(5);
    await ctx.deps.identity.setProactivityDial(companionId, 'off');

    await tick();

    expect(await assistantNotes()).toHaveLength(0);
    expect((await ctx.deps.energy.getEnergy(companionId)).usedTokens).toBe(0);
  });

  it('learns from the CHANGE in mood across the reaction, shifting the weight (DoD 5)', async () => {
    await seedLeads(3);
    // The companion acts on its own first (before any visit marks presence active):
    // reads the list and posts one report note that now awaits a reaction.
    await tick();
    expect(await ctx.deps.rewards.findLatestUnresolved(companionId)).not.toBeNull();
    // The user was neutral before the companion acted — the baseline the change is
    // measured against (the agent loop would have stored this on a prior turn).
    await ctx.deps.affect.upsert(companionId, { valence: 0, note: 'neutral' });
    // Suppress the post-send background tick so the LLM-turn order stays exact.
    ctx.deps.motivation.request = (): void => {};

    // Reaction turn: the user warms up. The agent loop senses the mood in the same
    // turn (scripted 0.9); the CHANGE (0 → 0.9) is the reward — no button, no
    // separate critic call, sensed as part of processing the message.
    await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/messages`,
      headers: auth,
      payload: { content: 'Oh nice — thanks for reading those!' },
    });

    // The outcome is resolved with the positive change and the curiosity weight rose.
    const [outcome] = await ctx.deps.rewards.list(companionId, 1);
    expect(outcome!.reward).toBeCloseTo(0.9);
    expect(outcome!.resolvedAt).not.toBeNull();
    const companion = await ctx.deps.identity.getCompanionById(companionId);
    expect(companion?.driveWeights?.curiosity).toBeGreaterThan(0.5);
  });
});
