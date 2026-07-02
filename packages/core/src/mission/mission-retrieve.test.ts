import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companions, users, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { createMissionRetrieveContext } from './mission-retrieve.js';
import { MissionService } from './mission-service.js';
import { DrizzleMissionJournalStore, DrizzleMissionStore } from './mission-store.js';

describe('createMissionRetrieveContext', () => {
  let db: Database;
  let close: () => Promise<void>;
  let missions: DrizzleMissionStore;
  let journal: DrizzleMissionJournalStore;
  let service: MissionService;
  let companionId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    missions = new DrizzleMissionStore(db);
    journal = new DrizzleMissionJournalStore(db);
    service = new MissionService(missions, journal);
    const [user] = await db.insert(users).values({ email: 'r@example.com' }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pip', form: 'fox', temperament: 'curious' })
      .returning();
    companionId = companion!.id;
  });

  afterEach(async () => {
    await close();
  });

  it('contributes nothing when there is no active mission', async () => {
    const arm = createMissionRetrieveContext(missions, journal);
    const result = await arm({ companionId, userContent: 'anything' });
    expect(result.blocks).toEqual([]);
    expect(result.usage.totalTokens).toBe(0);
  });

  it('injects the goal, plan, criteria, and recent journal for an active mission', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    await service.activate(draft.id, {
      plan: 'poll every 1s; wake on < 810',
      validationCriteria: 'user says stop',
      jobIds: ['j1'],
      reportChannel: 'dm-1',
    });
    await service.recordJournal(draft.id, { findings: 'LITE at 815, steady' });

    const arm = createMissionRetrieveContext(missions, journal);
    const result = await arm({ companionId, userContent: 'LITE is 808' });

    expect(result.blocks).toHaveLength(1);
    const content = result.blocks[0]!.content;
    expect(result.blocks[0]!.role).toBe('system');
    expect(content).toContain('monitor LITE');
    expect(content).toContain('poll every 1s; wake on < 810');
    expect(content).toContain('user says stop');
    expect(content).toContain('LITE at 815, steady');
    expect(result.usage.totalTokens).toBe(0);
  });

  it('notes the first turn when the journal is empty', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    await service.activate(draft.id, {
      plan: 'p',
      validationCriteria: 'c',
      jobIds: ['j1'],
      reportChannel: 'dm-1',
    });
    const arm = createMissionRetrieveContext(missions, journal);
    const result = await arm({ companionId, userContent: 'go' });
    expect(result.blocks[0]!.content).toContain('first turn');
  });
});
