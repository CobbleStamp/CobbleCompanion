/**
 * Growth service — derives the four axes from real substrate, advances the mark
 * idempotently, awards treats, and posts growth notes. Exercised over the
 * in-memory DB with the real stores (fakes-over-mocks: a real PGlite, not stubs).
 */

import { type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleEpisodicMemoryStore } from '../memory/episodic-store.js';
import { TranscriptMemoryStore } from '../memory/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import { DrizzleCompanionAffectStore } from '../motivation/affect-store.js';
import { DrizzleProactiveOutcomeStore } from '../motivation/reward-store.js';
import { DrizzleProceduralStore } from '../tools/procedural-store.js';
import { DrizzleToolCallLog } from '../tools/tool-call-log.js';
import { DEFAULT_GROWTH_CONFIG } from './config.js';
import { DrizzleGrowthStore } from './growth-store.js';
import { GrowthService } from './service.js';

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

describe('GrowthService', () => {
  let db: Database;
  let close: () => Promise<void>;
  let companionId: string;
  let service: GrowthService;
  let identity: DrizzleIdentityStore;
  let semantic: DrizzleSemanticMemoryStore;
  let episodic: DrizzleEpisodicMemoryStore;
  let procedural: DrizzleProceduralStore;
  let toolCallLog: DrizzleToolCallLog;
  let rewards: DrizzleProactiveOutcomeStore;
  let affect: DrizzleCompanionAffectStore;
  let memory: TranscriptMemoryStore;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    identity = new DrizzleIdentityStore(db);
    semantic = new DrizzleSemanticMemoryStore(db);
    episodic = new DrizzleEpisodicMemoryStore(db);
    procedural = new DrizzleProceduralStore(db);
    toolCallLog = new DrizzleToolCallLog(db);
    rewards = new DrizzleProactiveOutcomeStore(db);
    affect = new DrizzleCompanionAffectStore(db);
    memory = new TranscriptMemoryStore(db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'Pip',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
    service = new GrowthService({
      identity,
      semantic,
      episodic,
      procedural,
      toolCallLog,
      rewards,
      affect,
      growth: new DrizzleGrowthStore(db, { initialTreats: DEFAULT_GROWTH_CONFIG.initialTreats }),
      memory,
      logger: silentLogger,
    });
  });
  afterEach(async () => {
    await close();
  });

  async function assistantNotes(): Promise<readonly string[]> {
    const messages = await memory.getRecentMessages(companionId, 50);
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  }

  it('reports a fresh, unformed companion at stage 0', async () => {
    const dto = await service.snapshot(companionId);
    expect(dto.overallStage).toBe(0);
    expect(dto.emoji).toBe(DEFAULT_GROWTH_CONFIG.stageEmoji[0]);
    expect(dto.treats).toBe(DEFAULT_GROWTH_CONFIG.initialTreats);
    expect(dto.knowledge.level).toBe(0);
    expect(dto.personality.spread).toBe(0);
    expect(dto.abilities.every((a) => !a.unlocked)).toBe(true);
  });

  it('derives axes/abilities from substrate, awards treats, and posts growth notes', async () => {
    // Knowledge: 4 sources × 3 points = 12 ≥ 10 → level 1, unlocks reading_sources.
    for (let i = 0; i < 4; i += 1) {
      await semantic.createSource(companionId, {
        kind: 'note',
        title: `note ${i}`,
        rawText: 'hello world',
      });
    }
    // Abilities from the tool/procedure/affect/reward logs.
    await toolCallLog.record(companionId, 'web_fetch', {}, 'ok');
    await toolCallLog.record(companionId, 'memory_search', {}, 'ok');
    await procedural.record(companionId, 'book a hotel', ['web_fetch', 'ingest_source']);
    await affect.upsert(companionId, { valence: 0.4, note: 'pleased' });
    await rewards.record(companionId, { drive: 'curiosity' });

    const transition = await service.recompute(companionId);
    expect(transition.knowledgeLevelUps).toBe(1);
    expect(transition.newAbilities).toContain('reading_sources');
    expect(transition.newAbilities).toContain('web_research');
    expect(transition.treatsEarned).toBeGreaterThan(0);

    const dto = await service.snapshot(companionId);
    expect(dto.knowledge.level).toBe(1);
    expect(dto.abilities.find((a) => a.key === 'web_research')?.unlocked).toBe(true);
    expect(dto.abilities.find((a) => a.key === 'first_routine')?.unlocked).toBe(true);
    expect(dto.treats).toBe(DEFAULT_GROWTH_CONFIG.initialTreats + transition.treatsEarned);

    const notes = await assistantNotes();
    expect(notes.some((n) => n.includes('Knowledge'))).toBe(true);
  });

  it('is idempotent — a second recompute neither re-awards treats nor re-posts notes', async () => {
    await semantic.createSource(companionId, { kind: 'note', title: 'n', rawText: 'hi' });
    await toolCallLog.record(companionId, 'web_fetch', {}, 'ok');

    const first = await service.recompute(companionId);
    expect(first.newAbilities.length).toBeGreaterThan(0);
    const treatsAfterFirst = (await service.snapshot(companionId)).treats;
    const notesAfterFirst = (await assistantNotes()).length;

    const second = await service.recompute(companionId);
    expect(second.newAbilities).toEqual([]);
    expect(second.treatsEarned).toBe(0);
    expect((await service.snapshot(companionId)).treats).toBe(treatsAfterFirst);
    expect((await assistantNotes()).length).toBe(notesAfterFirst);
  });

  it('surfaces the emerged personality once weights diverge from neutral', async () => {
    await identity.updateDriveWeights(companionId, {
      curiosity: 0.9,
      bond: 0.8,
      understanding: 0.5,
      approval: 0.5,
      helpfulness: 0.5,
      upkeep: 0.5,
    });
    const dto = await service.snapshot(companionId);
    expect(dto.personality.spread).toBeGreaterThan(0);
    expect(dto.personality.weights.curiosity).toBeCloseTo(0.9);
  });
});
