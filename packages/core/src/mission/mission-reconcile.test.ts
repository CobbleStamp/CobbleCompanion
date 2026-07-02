import { companions, users, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging.js';
import { reconcileMissionJobs, routeMissionAdvance } from './mission-reconcile.js';
import type { MissionScheduler } from './mission-scheduler.js';
import { MissionService } from './mission-service.js';
import { DrizzleMissionJournalStore, DrizzleMissionStore } from './mission-store.js';

const silent: Logger = { error: () => undefined, warn: () => undefined, info: () => undefined };

/** A scheduler fake recording cancels; ids in `failOn` refuse to cancel. */
function fakeScheduler(): MissionScheduler & { cancelled: string[]; failOn: Set<string> } {
  const cancelled: string[] = [];
  const failOn = new Set<string>();
  return {
    cancelled,
    failOn,
    async arm() {
      return 'job';
    },
    async cancel(jobId) {
      if (failOn.has(jobId)) throw new Error(`cancel refused: ${jobId}`);
      cancelled.push(jobId);
    },
  };
}

describe('reconcileMissionJobs', () => {
  let db: Database;
  let close: () => Promise<void>;
  let service: MissionService;
  let companionId: string;
  let scheduler: ReturnType<typeof fakeScheduler>;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    service = new MissionService(new DrizzleMissionStore(db), new DrizzleMissionJournalStore(db));
    const [user] = await db.insert(users).values({ email: 'r@example.com' }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pip', form: 'fox', temperament: 'curious' })
      .returning();
    companionId = companion!.id;
    scheduler = fakeScheduler();
  });

  afterEach(async () => {
    await close();
  });

  /** Create a stopped mission carrying the given wake jobs (the reconcile subject). */
  async function stoppedMissionWithJobs(jobIds: string[]): Promise<string> {
    const draft = await service.createDraft(companionId, 'monitor');
    await service.activate(draft.id, { plan: 'p', validationCriteria: 'c', jobIds });
    await service.stop(draft.id);
    return draft.id;
  }

  it('cancels every job and clears jobIds when all cancels succeed', async () => {
    const missionId = await stoppedMissionWithJobs(['job-a', 'job-b']);

    const stillArmed = await reconcileMissionJobs(
      { missions: service, scheduler, logger: silent },
      missionId,
      ['job-a', 'job-b'],
    );

    expect(stillArmed).toEqual([]);
    expect(scheduler.cancelled).toEqual(['job-a', 'job-b']);
    expect((await service.get(missionId))?.jobIds).toEqual([]);
  });

  it('keeps a failed cancel recorded so a later reconciliation retries exactly it', async () => {
    const missionId = await stoppedMissionWithJobs(['job-a', 'job-b']);
    scheduler.failOn.add('job-a');

    const stillArmed = await reconcileMissionJobs(
      { missions: service, scheduler, logger: silent },
      missionId,
      ['job-a', 'job-b'],
    );

    expect(stillArmed).toEqual(['job-a']);
    expect(scheduler.cancelled).toEqual(['job-b']);
    expect((await service.get(missionId))?.jobIds).toEqual(['job-a']);
  });

  it('records a not-yet-persisted job when its cancel fails (start_mission compensation shape)', async () => {
    // start_mission passes a just-armed job id that the mission does not yet carry (activate
    // never ran). A failed cancel must land on the row, or the id would exist nowhere.
    const draft = await service.createDraft(companionId, 'starting up'); // jobIds still []
    scheduler.failOn.add('armed-1');

    const stillArmed = await reconcileMissionJobs(
      { missions: service, scheduler, logger: silent },
      draft.id,
      ['armed-1'],
    );

    expect(stillArmed).toEqual(['armed-1']);
    expect((await service.get(draft.id))?.jobIds).toEqual(['armed-1']);
  });

  it('never throws when the settle write fails — the caller (stop/compensation) proceeds', async () => {
    const missionId = await stoppedMissionWithJobs(['job-a']);
    const brokenWrite = new MissionService(
      new DrizzleMissionStore(db),
      new DrizzleMissionJournalStore(db),
    );
    brokenWrite.reconcileJobs = async () => {
      throw new Error('db write failed');
    };

    const stillArmed = await reconcileMissionJobs(
      { missions: brokenWrite, scheduler, logger: silent },
      missionId,
      ['job-a'],
    );

    // The cancel still happened and the survivor set is returned; the swallowed write just
    // leaves the row's pre-cancel ids in place for the next wake to reconcile afresh.
    expect(stillArmed).toEqual([]);
    expect(scheduler.cancelled).toEqual(['job-a']);
  });
});

describe('routeMissionAdvance', () => {
  let db: Database;
  let close: () => Promise<void>;
  let service: MissionService;
  let companionId: string;
  let scheduler: ReturnType<typeof fakeScheduler>;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    service = new MissionService(new DrizzleMissionStore(db), new DrizzleMissionJournalStore(db));
    const [user] = await db.insert(users).values({ email: 'r@example.com' }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pip', form: 'fox', temperament: 'curious' })
      .returning();
    companionId = companion!.id;
    scheduler = fakeScheduler();
  });

  afterEach(async () => {
    await close();
  });

  const deps = () => ({ missions: service, scheduler, logger: silent });

  it('routes an active mission to `advance` with the record', async () => {
    const draft = await service.createDraft(companionId, 'monitor');
    const active = await service.activate(draft.id, {
      plan: 'p',
      validationCriteria: 'c',
      jobIds: ['job-1'],
    });

    const routing = await routeMissionAdvance(deps(), companionId, active!.id);

    expect(routing.kind).toBe('advance');
    if (routing.kind === 'advance') expect(routing.mission.id).toBe(active!.id);
    expect(scheduler.cancelled).toEqual([]);
  });

  it('skips an unknown mission id (unknown mission), cancelling nothing', async () => {
    const routing = await routeMissionAdvance(
      deps(),
      companionId,
      '00000000-0000-4000-8000-000000000000',
    );

    expect(routing).toEqual({ kind: 'skip', reason: 'unknown mission' });
    expect(scheduler.cancelled).toEqual([]);
  });

  it('skips another companion’s mission as unknown (no tenancy leak), cancelling nothing', async () => {
    const [other] = await db.insert(users).values({ email: 'x@example.com' }).returning();
    const [otherCompanion] = await db
      .insert(companions)
      .values({ ownerId: other!.id, name: 'Fen', form: 'cat', temperament: 'aloof' })
      .returning();
    const foreign = await service.createDraft(otherCompanion!.id, 'not yours');
    await service.activate(foreign.id, { plan: 'p', validationCriteria: 'c', jobIds: ['job-f'] });
    await service.stop(foreign.id);

    const routing = await routeMissionAdvance(deps(), companionId, foreign.id);

    expect(routing).toEqual({ kind: 'skip', reason: 'unknown mission' });
    expect(scheduler.cancelled).toEqual([]);
    expect((await service.get(foreign.id))?.jobIds).toEqual(['job-f']);
  });

  it('skips a draft mission WITHOUT cancelling (arm→activate window)', async () => {
    const draft = await service.createDraft(companionId, 'starting up');

    const routing = await routeMissionAdvance(deps(), companionId, draft.id);

    expect(routing).toEqual({ kind: 'skip', reason: 'mission not active' });
    expect(scheduler.cancelled).toEqual([]);
  });

  it('skips a terminal mission AND reconciles its stale jobs', async () => {
    const draft = await service.createDraft(companionId, 'monitor');
    await service.activate(draft.id, {
      plan: 'p',
      validationCriteria: 'c',
      jobIds: ['job-a', 'job-b'],
    });
    await service.stop(draft.id);
    scheduler.failOn.add('job-b');

    const routing = await routeMissionAdvance(deps(), companionId, draft.id);

    expect(routing).toEqual({ kind: 'skip', reason: 'mission not active' });
    expect(scheduler.cancelled).toEqual(['job-a']);
    expect((await service.get(draft.id))?.jobIds).toEqual(['job-b']);
  });
});
