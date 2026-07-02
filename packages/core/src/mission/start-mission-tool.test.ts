import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companions, users, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import { MissionService } from './mission-service.js';
import { DrizzleMissionJournalStore, DrizzleMissionStore } from './mission-store.js';
import {
  createStartMissionTool,
  type MissionJobSpec,
  type MissionScheduler,
  type MissionWakeConfig,
  type MissionWakeTarget,
} from './start-mission-tool.js';

const silent: Logger = { error: () => undefined, warn: () => undefined, info: () => undefined };

/** A scheduler fake that records what it armed / cancelled and hands back a fixed job id. */
function fakeScheduler(): MissionScheduler & { armed: MissionJobSpec[]; cancelled: string[] } {
  const armed: MissionJobSpec[] = [];
  const cancelled: string[] = [];
  return {
    armed,
    cancelled,
    async arm(spec) {
      armed.push(spec);
      return 'job-1';
    },
    async cancel(jobId) {
      cancelled.push(jobId);
    },
  };
}

const wakeConfigWith = (target: MissionWakeTarget | null): MissionWakeConfig => ({
  forOwner: async () => target,
});

const args = {
  goal: 'monitor LITE and warn on a drop',
  plan: 'poll the quote; wake and reason when it breaks 810',
  validationCriteria: 'the user says stop',
  predicate: 'ibkr-cli query LITE le 810',
  every: '1s',
};

describe('createStartMissionTool', () => {
  let db: Database;
  let close: () => Promise<void>;
  let missions: DrizzleMissionStore;
  let service: MissionService;
  let ctx: TurnCtx;

  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    missions = new DrizzleMissionStore(db);
    service = new MissionService(missions, new DrizzleMissionJournalStore(db));
    const [user] = await db.insert(users).values({ email: 'r@example.com' }).returning();
    const [companion] = await db
      .insert(companions)
      .values({ ownerId: user!.id, name: 'Pip', form: 'fox', temperament: 'curious' })
      .returning();
    ctx = { companionId: companion!.id, ownerId: user!.id };
  });

  afterEach(async () => {
    await close();
  });

  it('is an effectful tool the gate will hold for approval', () => {
    const tool = createStartMissionTool({
      missions: service,
      scheduler: fakeScheduler(),
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });
    expect(tool.effectful).toBe(true);
    expect(tool.proposalSummary?.(args)).toContain('monitor LITE');
    expect(tool.proposalSummary?.(args)).toContain('ibkr-cli query LITE le 810');
  });

  it('the proposal summary shows the plan and the success criteria (the plan review)', () => {
    const tool = createStartMissionTool({
      missions: service,
      scheduler: fakeScheduler(),
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const summary = tool.proposalSummary!(args);

    expect(summary).toContain('Plan: poll the quote; wake and reason when it breaks 810');
    expect(summary).toContain('Done when: the user says stop');
  });

  it('truncates a long plan and criteria in the proposal summary', () => {
    const tool = createStartMissionTool({
      missions: service,
      scheduler: fakeScheduler(),
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const summary = tool.proposalSummary!({
      ...args,
      plan: 'p'.repeat(1_000),
      validationCriteria: 'c'.repeat(1_000),
    });

    expect(summary).toContain('…');
    // Comfortably inside a Discord embed description (4096) with headroom for the header.
    expect(summary.length).toBeLessThan(1_000);
  });

  it('arms the wake job (mentioning the bot) and activates the mission on run', async () => {
    const scheduler = fakeScheduler();
    const tool = createStartMissionTool({
      missions: service,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'mission-chan', botUserId: 'bot-42' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBeUndefined();
    // The wake job carries the predicate + interval and a discord-notify action that mentions the bot.
    expect(scheduler.armed).toHaveLength(1);
    const spec = scheduler.armed[0]!;
    expect(spec.predicate).toBe('ibkr-cli query LITE le 810');
    expect(spec.every).toBe('1s');
    expect(spec.action).toEqual([
      'discord-notify',
      '--channel',
      'mission-chan',
      '--text',
      '<@bot-42> {{message}}',
    ]);

    // The mission is now active, records the job id, and suspends drives.
    const active = await service.findActive(ctx.companionId);
    expect(active?.goal).toBe(args.goal);
    expect(active?.plan).toBe(args.plan);
    expect(active?.validationCriteria).toBe(args.validationCriteria);
    expect(active?.jobIds).toEqual(['job-1']);
    expect(await service.hasActive(ctx.companionId)).toBe(true);
  });

  it('refuses (and arms nothing) when a mission is already active', async () => {
    const draft = await service.createDraft(ctx.companionId, 'existing');
    await service.activate(draft.id, {
      plan: 'p',
      validationCriteria: 'c',
      jobIds: ['old'],
    });
    const scheduler = fakeScheduler();
    const tool = createStartMissionTool({
      missions: service,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('already on an active mission');
    expect(scheduler.armed).toEqual([]);
  });

  it('errors (and arms nothing) when the mission wake is not configured', async () => {
    const scheduler = fakeScheduler();
    const tool = createStartMissionTool({
      missions: service,
      scheduler,
      wakeConfig: wakeConfigWith(null),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('wake is not configured');
    expect(scheduler.armed).toEqual([]);
    expect(await service.hasActive(ctx.companionId)).toBe(false);
  });

  it('rejects incomplete arguments before touching the scheduler', async () => {
    const scheduler = fakeScheduler();
    const tool = createStartMissionTool({
      missions: service,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run({ ...args, predicate: '   ' }, ctx);

    expect(result.isError).toBe(true);
    expect(scheduler.armed).toEqual([]);
  });

  it('cancels the armed job if activation fails (no orphaned wake)', async () => {
    const scheduler = fakeScheduler();
    // A missions port whose activate() always fails, to exercise the compensation path.
    const failingMissions = {
      hasActive: async () => false,
      createDraft: async (companionId: string, goal: string) =>
        service.createDraft(companionId, goal),
      activate: async () => null,
    } as unknown as MissionService;
    const tool = createStartMissionTool({
      missions: failingMissions,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(scheduler.cancelled).toEqual(['job-1']);
  });
});
