import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companions, users, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { DrizzleMissionJournalStore, DrizzleMissionStore } from './mission-store.js';
import { MissionService } from './mission-service.js';

describe('MissionService', () => {
  let db: Database;
  let close: () => Promise<void>;
  let service: MissionService;
  let companionId: string;

  const activation = {
    plan: 'poll LITE; wake on < 810',
    validationCriteria: 'user says stop',
    jobIds: ['job_1'],
  };

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    service = new MissionService(new DrizzleMissionStore(db), new DrizzleMissionJournalStore(db));
    const [user] = await db.insert(users).values({ email: 'm@example.com' }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pip', form: 'fox', temperament: 'curious' })
      .returning();
    companionId = companion!.id;
  });

  afterEach(async () => {
    await close();
  });

  it('creates a draft, activates it, and reports it as the active mission', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    expect(draft.status).toBe('draft');
    expect(await service.hasActive(companionId)).toBe(false);

    const active = await service.activate(draft.id, activation);
    expect(active?.status).toBe('active');
    expect(await service.hasActive(companionId)).toBe(true);
    expect((await service.findActive(companionId))?.id).toBe(draft.id);
  });

  it('stop is a no-op once terminal', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    await service.activate(draft.id, activation);

    expect((await service.stop(draft.id))?.status).toBe('stopped');
    // Already stopped (terminal): a second stop no longer applies.
    expect(await service.stop(draft.id)).toBeNull();
    expect(await service.hasActive(companionId)).toBe(false);
  });

  it('appends and recalls journal rows newest-first', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    await service.recordJournal(draft.id, { event: 'first', findings: 'a' });
    await service.recordJournal(draft.id, { event: 'second', findings: 'b' });

    const recent = await service.recentJournal(draft.id, 5);
    expect(recent.map((r) => r.event)).toEqual(['second', 'first']);
  });
});
