/**
 * Phase 4 Definition-of-Done — the differentiator, mechanically verified offline
 * (development-plan.md §3). Drives the real motivation engine through the app's
 * stores and asserts:
 *   1. Open the app with no prompt → Cobble offers a relevant autonomous proposal.
 *   2. Energy is consumed by the self-initiated work.
 *   3. Out of energy → no initiation and no further spend (chat still runs on stamina).
 *   4. Dial off → no initiation.
 *   5. Approving an autonomous proposal captures reward, shifts the drive weight,
 *      and does NOT re-enter the chat loop (the engine owns "what next").
 *
 * Deterministic: a fake gateway, the in-memory store, neutral weights + the
 * default gentle dial, and a directly-awaited engine tick (request → whenIdle).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('Phase 4 DoD — proactivity engine', () => {
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

  it('offers a relevant autonomous proposal with no prompt, consuming energy (DoD 1+2)', async () => {
    await seedLeads(5);
    await tick();

    const pending = await ctx.deps.proposals.listPending(companionId);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => p.origin === 'autonomous')).toBe(true);
    expect(pending.every((p) => p.toolName === 'ingest_source')).toBe(true);
    // A reinforcement outcome was logged for each initiation.
    expect((await ctx.deps.rewards.list(companionId, 10)).length).toBe(pending.length);
    // Energy was consumed by the self-initiated work.
    expect((await ctx.deps.energy.getEnergy(companionId)).usedTokens).toBeGreaterThan(0);
  });

  it('stops initiating when out of energy, with no further spend (DoD 3)', async () => {
    await seedLeads(5);
    await ctx.deps.energy.recordSpend(companionId, ctx.deps.config.tokenCapPerDay); // exhaust
    const before = (await ctx.deps.energy.getEnergy(companionId)).usedTokens;

    await tick();

    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
    expect((await ctx.deps.energy.getEnergy(companionId)).usedTokens).toBe(before);
  });

  it('does not initiate when the dial is off (DoD 4)', async () => {
    await seedLeads(5);
    await ctx.deps.identity.setProactivityDial(companionId, 'off');

    await tick();

    expect(await ctx.deps.proposals.listPending(companionId)).toHaveLength(0);
  });

  it('approving an autonomous proposal rewards it, shifts the weight, and does not re-enter chat (DoD 5)', async () => {
    await seedLeads(5);
    await tick();
    const [proposal] = await ctx.deps.proposals.listPending(companionId);
    expect(proposal).toBeDefined();
    // Suppress the post-approval engine nudge so the assertion is deterministic.
    ctx.deps.motivation.request = (): void => {};

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/companions/${companionId}/proposals/${proposal!.id}/confirm`,
      headers: auth,
    });

    // The action ran, but the loop did NOT re-enter (no scripted narration).
    expect(res.body).toContain('"type":"done"');
    expect(res.body).not.toContain('Hi there');
    const transcript = await ctx.deps.memory.getRecentMessages(companionId, 20);
    expect(transcript.map((m) => m.content)).not.toContain('Hi there');
    // Reward captured and the served drive's weight shifted upward.
    expect((await ctx.deps.rewards.findByProposal(companionId, proposal!.id))?.reward).toBe(1);
    const companion = await ctx.deps.identity.getCompanionById(companionId);
    expect(companion?.driveWeights?.curiosity).toBeGreaterThan(0.5);
  });
});
