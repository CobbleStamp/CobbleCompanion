import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companions, users, type Database } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import type { TurnCtx } from '../harness/hooks.js';
import type { Logger } from '../logging.js';
import { MissionService } from './mission-service.js';
import { DrizzleMissionJournalStore, DrizzleMissionStore } from './mission-store.js';
import type { MissionJobSpec, MissionScheduler } from './mission-scheduler.js';
import {
  createStartMissionTool,
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

  it('degrades the proposal summary gracefully on incomplete args (pre-validation)', () => {
    // The gate renders the card from the model's RAW args, before run() validates them.
    const tool = createStartMissionTool({
      missions: service,
      scheduler: fakeScheduler(),
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    expect(tool.proposalSummary!({})).toBe('Start a mission');
    // A goal without a predicate/interval: headline only, no monitor clause.
    const goalOnly = tool.proposalSummary!({ goal: 'watch LITE' });
    expect(goalOnly).toBe('Start mission: watch LITE');
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

  it('caps the predicate and interval in the summary and strips backticks (embed safety)', () => {
    // Model-authored strings: an oversized predicate must not blow the 4096 embed limit
    // (the card would fail to post and the owner could never approve), and a backtick in
    // it must not break out of the summary's own inline-code span.
    const tool = createStartMissionTool({
      missions: service,
      scheduler: fakeScheduler(),
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const summary = tool.proposalSummary!({
      ...args,
      predicate: '`p`'.repeat(1_000),
      every: 'e'.repeat(1_000),
    });

    expect(summary).toContain('monitor `pp');
    expect(summary).not.toContain('`p`'); // the predicate's own backticks are stripped
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
    // The mission is now active, records the job id, and suspends drives.
    const active = await service.findActive(ctx.companionId);
    expect(active?.goal).toBe(args.goal);
    expect(active?.plan).toBe(args.plan);
    expect(active?.validationCriteria).toBe(args.validationCriteria);
    expect(active?.jobIds).toEqual(['job-1']);
    expect(await service.hasActive(ctx.companionId)).toBe(true);

    // The wake job carries the predicate + interval, and a discord-notify action that
    // mentions the bot AND names the mission — every trigger is identifiable (§3.2).
    expect(scheduler.armed).toHaveLength(1);
    const spec = scheduler.armed[0]!;
    expect(spec.predicate).toBe('ibkr-cli query LITE le 810');
    expect(spec.every).toBe('1s');
    expect(spec.action).toEqual([
      'discord-notify',
      '--channel',
      'mission-chan',
      '--text',
      `<@bot-42> mission:${active!.id} {{message}}`,
    ]);
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

  it('cancels the armed job and stops the draft if activation fails (no orphans)', async () => {
    const scheduler = fakeScheduler();
    // A missions port whose activate() always fails, to exercise the compensation path.
    const failingMissions = {
      hasActive: async () => false,
      createDraft: async (companionId: string, goal: string) =>
        service.createDraft(companionId, goal),
      activate: async () => null,
      stop: (missionId: string) => service.stop(missionId),
      reconcileJobs: (missionId: string, cancelled: readonly string[], failed: readonly string[]) =>
        service.reconcileJobs(missionId, cancelled, failed),
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
    // The losing draft was stopped, not left lingering as a phantom.
    const [record] = await service.list(ctx.companionId);
    expect(record?.status).toBe('stopped');
  });

  it('returns an error and arms nothing when creating the draft fails', async () => {
    // The draft comes FIRST (its id rides the wake action) — a failure there must leave
    // the scheduler untouched, or a job would fire for a mission that never existed.
    const scheduler = fakeScheduler();
    const failingMissions = {
      hasActive: async () => false,
      createDraft: async () => {
        throw new Error('db unavailable');
      },
    } as unknown as MissionService;
    const tool = createStartMissionTool({
      missions: failingMissions,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('starting the mission');
    expect(scheduler.armed).toEqual([]);
  });

  it('still reports the arming error when the compensating draft-stop also fails', async () => {
    const scheduler = fakeScheduler();
    scheduler.arm = async () => {
      throw new Error('scheduler unreachable');
    };
    const stopFailingMissions = {
      hasActive: async () => false,
      createDraft: async (companionId: string, goal: string) =>
        service.createDraft(companionId, goal),
      stop: async () => {
        throw new Error('stop failed too');
      },
    } as unknown as MissionService;
    const tool = createStartMissionTool({
      missions: stopFailingMissions,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    // The compensation failure is logged and swallowed — the owner sees the real cause.
    expect(result.isError).toBe(true);
    expect(result.content).toContain('arming the mission monitor');
  });

  it('still reports the activation race when the compensating job cancel also fails', async () => {
    const scheduler = fakeScheduler();
    scheduler.cancel = async () => {
      throw new Error('cancel refused');
    };
    const racingMissions = {
      hasActive: async () => false,
      createDraft: async (companionId: string, goal: string) =>
        service.createDraft(companionId, goal),
      activate: async () => null,
      stop: (missionId: string) => service.stop(missionId),
      reconcileJobs: (missionId: string, cancelled: readonly string[], failed: readonly string[]) =>
        service.reconcileJobs(missionId, cancelled, failed),
    } as unknown as MissionService;
    const tool = createStartMissionTool({
      missions: racingMissions,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('could not activate');
    // The other compensation leg still ran: the losing draft was stopped — AND the job
    // whose cancel failed was recorded on it (only activate writes jobIds, and it never
    // ran), so the stale wake's reconciliation (§5.2 step 1) can retry exactly that
    // cancel instead of the job firing every interval forever.
    const [record] = await service.list(ctx.companionId);
    expect(record?.status).toBe('stopped');
    expect(record?.jobIds).toEqual(['job-1']);
  });

  it('still reports the activation failure when recording the uncancelled job also fails', async () => {
    const scheduler = fakeScheduler();
    scheduler.cancel = async () => {
      throw new Error('cancel refused');
    };
    const doublyFailingMissions = {
      hasActive: async () => false,
      createDraft: async (companionId: string, goal: string) =>
        service.createDraft(companionId, goal),
      activate: async () => null,
      stop: (missionId: string) => service.stop(missionId),
      reconcileJobs: async () => {
        throw new Error('db write failed');
      },
    } as unknown as MissionService;
    const tool = createStartMissionTool({
      missions: doublyFailingMissions,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    // Both compensation failures are logged and swallowed — the owner sees the real cause.
    expect(result.isError).toBe(true);
    expect(result.content).toContain('could not activate');
  });

  it('cancels the job and stops the draft when activate THROWS (not just when it races)', async () => {
    const scheduler = fakeScheduler();
    const throwingMissions = {
      hasActive: async () => false,
      createDraft: async (companionId: string, goal: string) =>
        service.createDraft(companionId, goal),
      activate: async () => {
        throw new Error('db write failed');
      },
      stop: (missionId: string) => service.stop(missionId),
      reconcileJobs: (missionId: string, cancelled: readonly string[], failed: readonly string[]) =>
        service.reconcileJobs(missionId, cancelled, failed),
    } as unknown as MissionService;
    const tool = createStartMissionTool({
      missions: throwingMissions,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(scheduler.cancelled).toEqual(['job-1']);
    const [record] = await service.list(ctx.companionId);
    expect(record?.status).toBe('stopped');
  });

  it('stops the draft if arming the wake job fails (no phantom draft)', async () => {
    const scheduler = fakeScheduler();
    scheduler.arm = async () => {
      throw new Error('scheduler unreachable');
    };
    const tool = createStartMissionTool({
      missions: service,
      scheduler,
      wakeConfig: wakeConfigWith({ missionChannelId: 'ch', botUserId: 'bot' }),
      logger: silent,
    });

    const result = await tool.run(args, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('arming the mission monitor');
    expect(await service.hasActive(ctx.companionId)).toBe(false);
    // The draft created for the wake's mission id was stopped, not left as a phantom.
    const [record] = await service.list(ctx.companionId);
    expect(record?.status).toBe('stopped');
  });
});
