/**
 * The mission WS methods (companion-missions.md §3.4). Covers the request/response methods
 * (`mission.list` / `mission.stop`) over a real MissionService on an in-memory DB + fakes, the
 * registration guard (missions register only when both the service and scheduler are wired), and
 * the `withMissionJournal` wrapper that appends the wake turn's report to the journal.
 */

import {
  DrizzleMissionJournalStore,
  DrizzleMissionStore,
  MissionService,
  type Logger,
  type MissionScheduler,
} from '@cobble/core';
import { companions, users, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { ChatStreamEvent, MessageDto } from '@cobble/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../app.js';
import type { WsCallContext } from '../dispatch.js';
import { missionMethods, withMissionJournal } from './missions.js';

const silent: Logger = { error: () => undefined, warn: () => undefined, info: () => undefined };

/** A scheduler fake that records cancellations. */
function fakeScheduler(): MissionScheduler & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    async arm() {
      return 'job';
    },
    async cancel(jobId) {
      cancelled.push(jobId);
    },
  };
}

const doneEvent = (content: string): ChatStreamEvent => ({
  type: 'done',
  message: { content } as MessageDto,
});

/** An async generator over a fixed event list, returning `superseded`. */
async function* streamOf(
  events: readonly ChatStreamEvent[],
  superseded = false,
): AsyncGenerator<ChatStreamEvent, boolean> {
  for (const event of events) {
    yield event;
  }
  return superseded;
}

describe('missionMethods', () => {
  let db: Database;
  let close: () => Promise<void>;
  let service: MissionService;
  let companionId: string;
  let scheduler: ReturnType<typeof fakeScheduler>;
  let motivationRequest: ReturnType<typeof vi.fn>;
  let ctx: WsCallContext;

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
    motivationRequest = vi.fn();
    ctx = {
      userId: user!.id,
      embodiment: { companionId, connectionId: 'conn-1', claimSeq: 1 },
    } as unknown as WsCallContext;
  });

  afterEach(async () => {
    await close();
  });

  function deps(): AppDeps {
    return {
      missions: service,
      missionScheduler: scheduler,
      embodiment: { holds: async () => true },
      motivation: { request: motivationRequest },
      logger: silent,
    } as unknown as AppDeps;
  }

  it('registers no methods when the mission service or scheduler is absent', () => {
    expect(missionMethods({} as AppDeps)).toEqual({});
    expect(missionMethods({ missions: service } as unknown as AppDeps)).toEqual({});
    expect(missionMethods({ missionScheduler: scheduler } as unknown as AppDeps)).toEqual({});
  });

  it('registers the mission methods when both are wired', () => {
    expect(Object.keys(missionMethods(deps())).sort()).toEqual([
      'mission.advance',
      'mission.create',
      'mission.list',
      'mission.stop',
    ]);
  });

  it('mission.list returns the embodied companion’s missions as DTOs (newest first)', async () => {
    await service.createDraft(companionId, 'first');
    const second = await service.createDraft(companionId, 'second');
    const methods = missionMethods(deps());

    const result = (await methods['mission.list']!(ctx, {})) as {
      missions: { id: string; goal: string; status: string; createdAt: string }[];
    };

    expect(result.missions).toHaveLength(2);
    expect(result.missions[0]!.id).toBe(second.id);
    expect(result.missions[0]!.goal).toBe('second');
    expect(result.missions[0]!.status).toBe('draft');
    // Dates are projected as ISO strings.
    expect(typeof result.missions[0]!.createdAt).toBe('string');
  });

  it('mission.stop cancels the wake jobs, stops the mission, and nudges drives', async () => {
    const draft = await service.createDraft(companionId, 'monitor');
    await service.activate(draft.id, {
      plan: 'p',
      validationCriteria: 'c',
      jobIds: ['job-a', 'job-b'],
      reportChannel: 'ch',
    });
    const methods = missionMethods(deps());

    const result = (await methods['mission.stop']!(ctx, { missionId: draft.id })) as {
      mission: { status: string };
    };

    expect(scheduler.cancelled).toEqual(['job-a', 'job-b']);
    expect(result.mission.status).toBe('stopped');
    expect(await service.hasActive(companionId)).toBe(false);
    expect(motivationRequest).toHaveBeenCalledWith(companionId);
  });

  it('mission.stop refuses a mission that belongs to another companion (tenancy)', async () => {
    // A second companion (other owner) with its own mission.
    const [other] = await db.insert(users).values({ email: 'o@example.com' }).returning();
    const [otherCompanion] = await db
      .insert(companions)
      .values({ ownerId: other!.id, name: 'Fen', form: 'cat', temperament: 'aloof' })
      .returning();
    const foreign = await service.createDraft(otherCompanion!.id, 'not yours');
    const methods = missionMethods(deps());

    await expect(methods['mission.stop']!(ctx, { missionId: foreign.id })).rejects.toThrow(
      /no such mission/,
    );
    expect(scheduler.cancelled).toEqual([]);
  });
});

describe('withMissionJournal', () => {
  let db: Database;
  let close: () => Promise<void>;
  let service: MissionService;
  let companionId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    service = new MissionService(new DrizzleMissionStore(db), new DrizzleMissionJournalStore(db));
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

  async function activeMission(): Promise<string> {
    const draft = await service.createDraft(companionId, 'monitor LITE');
    const active = await service.activate(draft.id, {
      plan: 'p',
      validationCriteria: 'c',
      jobIds: ['j'],
      reportChannel: 'ch',
    });
    return active!.id;
  }

  it('forwards every event and appends the done report to the journal as findings', async () => {
    const missionId = await activeMission();
    const events = [{ type: 'token', value: 'LITE ' } as ChatStreamEvent, doneEvent('LITE at 808')];

    const forwarded: ChatStreamEvent[] = [];
    const gen = withMissionJournal(streamOf(events), service, companionId, 'LITE is 808', silent);
    let next = await gen.next();
    while (!next.done) {
      forwarded.push(next.value);
      next = await gen.next();
    }

    expect(next.value).toBe(false);
    expect(forwarded).toEqual(events);
    const journal = await service.recentJournal(missionId, 10);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.event).toBe('LITE is 808');
    expect(journal[0]!.findings).toBe('LITE at 808');
  });

  it('journals nothing when the turn was superseded', async () => {
    const missionId = await activeMission();
    const gen = withMissionJournal(
      streamOf([doneEvent('x')], true),
      service,
      companionId,
      'e',
      silent,
    );
    let next = await gen.next();
    while (!next.done) next = await gen.next();

    expect(next.value).toBe(true);
    expect(await service.recentJournal(missionId, 10)).toHaveLength(0);
  });

  it('journals nothing when there is no active mission', async () => {
    const gen = withMissionJournal(streamOf([doneEvent('x')]), service, companionId, 'e', silent);
    let next = await gen.next();
    while (!next.done) next = await gen.next();

    expect(next.value).toBe(false);
    // No active mission → no row anywhere (findActive returns null).
    expect(await service.findActive(companionId)).toBeNull();
  });
});
