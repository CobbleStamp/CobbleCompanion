/**
 * Motivation engine tick (Phase 4.1) — idle is free; initiation READS the lead
 * inventory into memory (no approval), spends real energy, and posts one report
 * note; the gate (dial / energy / presence) suppresses initiation. The ingestion
 * pipeline is faked (a real read needs the network): the fake debits energy
 * through the per-run meter and marks the job done, so the engine's orchestration
 * — decide → read → note → outcome → energy — is what's under test.
 */

import { companions, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { IngestionTarget } from '../ingestion/runner.js';
import type { IngestionRunParams } from '../ingestion/pipeline.js';
import { FakeLlmGateway } from '../llm/fake.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleCompanionEnergyStore } from '../quota/energy-store.js';
import { DrizzleLeadStore } from '../tools/lead-store.js';
import { MotivationEngine } from './engine.js';
import { InMemoryPresenceStore } from './presence-store.js';
import { DrizzleProactiveOutcomeStore } from './reward-store.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };
const ENERGY_CAP = 10_000;
const TOKENS_PER_READ = 100;

/** Fake pipeline: simulate a successful read — bill the meter, flip job done. */
class FakeReadPipeline implements IngestionTarget {
  constructor(private readonly semantic: DrizzleSemanticMemoryStore) {}
  async run(params: IngestionRunParams): Promise<void> {
    if (params.meter) {
      await params.meter.quota.recordUsage(params.meter.accountId, TOKENS_PER_READ);
    }
    await this.semantic.updateJob(params.jobId, { status: 'done' });
  }
}

describe('MotivationEngine.tick', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let leads: DrizzleLeadStore;
  let semantic: DrizzleSemanticMemoryStore;
  let memory: TranscriptMemoryStore;
  let energy: DrizzleCompanionEnergyStore;
  let presence: InMemoryPresenceStore;
  let rewards: DrizzleProactiveOutcomeStore;
  let engine: MotivationEngine;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    leads = new DrizzleLeadStore(db);
    semantic = new DrizzleSemanticMemoryStore(db);
    memory = new TranscriptMemoryStore(db);
    energy = new DrizzleCompanionEnergyStore(db, { defaultCapTokens: ENERGY_CAP });
    presence = new InMemoryPresenceStore();
    rewards = new DrizzleProactiveOutcomeStore(db);
    engine = new MotivationEngine({
      identity,
      presence,
      energy,
      leads,
      semantic,
      pipeline: new FakeReadPipeline(semantic),
      memory,
      rewards,
      llm: new FakeLlmGateway(['Read ', 'three things.']),
      model: 'fake-model',
      logger: silent,
    });
  });
  afterEach(async () => {
    await close();
  });

  async function seedLeads(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await leads.record(companionId, `https://lead-${i}.dev`);
    }
  }

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  it('stays idle (free) when there are no leads', async () => {
    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(result.move).toBeNull();
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(0);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('reads the inventory autonomously, posts one note, spends real energy', async () => {
    await seedLeads(4);
    const result = await engine.tick(companionId);

    expect(result.initiated).toBe(true);
    expect(result.move?.kind).toBe('explore');
    // Default focus length 3 → three reads (the fourth lead is left for later).
    expect(result.sourcesRead).toBe(3);
    expect(await leads.listByStatus(companionId, ['ingested'])).toHaveLength(3);
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(1);

    // Real energy spent: three reads + the report note (> reads alone).
    expect(result.energySpent).toBeGreaterThan(3 * TOKENS_PER_READ);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(result.energySpent);

    // Exactly one in-character report note was posted (not one per source).
    const notes = await assistantNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('Read three things.');

    // One pending outcome, linked to the note, awaiting the user's reaction.
    const outcomes = await rewards.list(companionId, 10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.drive).toBe('curiosity');
    expect(outcomes[0]!.reward).toBeNull();
    expect(outcomes[0]!.noteMessageId).not.toBeNull();
  });

  it('stays idle when the dial is off', async () => {
    await seedLeads(4);
    await db
      .update(companions)
      .set({ proactivityDial: 'off' })
      .where(eq(companions.id, companionId));

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(0);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('stops initiating when energy is exhausted (chat would still run on stamina)', async () => {
    await seedLeads(4);
    await energy.recordSpend(companionId, ENERGY_CAP); // exhaust the pool
    expect(await energy.isExhausted(companionId)).toBe(true);

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    // No further spend beyond the exhausting debit; nothing read or posted.
    expect((await energy.getEnergy(companionId)).usedTokens).toBe(ENERGY_CAP);
    expect(await leads.listByStatus(companionId, ['new'])).toHaveLength(4);
    expect(await assistantNotes()).toHaveLength(0);
  });

  it('does not self-initiate while the user is actively engaged', async () => {
    await seedLeads(4);
    presence.recordActivity(companionId); // user just acted → active

    const result = await engine.tick(companionId);
    expect(result.initiated).toBe(false);
    expect(await assistantNotes()).toHaveLength(0);
  });
});
