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
    reportChannel: 'chan_1',
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

  it('pauses only an active mission and resumes only a paused one', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    // Pause before active is a no-op.
    expect(await service.pause(draft.id)).toBeNull();

    await service.activate(draft.id, activation);
    expect((await service.pause(draft.id))?.status).toBe('paused');
    // Drive engine auto-resumes: no active mission while paused.
    expect(await service.hasActive(companionId)).toBe(false);

    // Resume from paused only.
    expect((await service.resume(draft.id))?.status).toBe('active');
    expect(await service.hasActive(companionId)).toBe(true);
  });

  it('stop/complete are no-ops once terminal', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    await service.activate(draft.id, activation);

    expect((await service.stop(draft.id))?.status).toBe('stopped');
    // Already stopped (terminal): complete/stop no longer apply.
    expect(await service.complete(draft.id)).toBeNull();
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

  it('re-arms the scheduler job ids on an active mission', async () => {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    await service.activate(draft.id, activation);
    const rearmed = await service.setJobIds(draft.id, ['job_2']);
    expect(rearmed?.jobIds).toEqual(['job_2']);
  });
});
