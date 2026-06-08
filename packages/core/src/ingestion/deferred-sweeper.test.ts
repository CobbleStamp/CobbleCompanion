/**
 * Deferred-sweeper tests against the real store + serial runner with a fake
 * pipeline target: under-cap companions' parked jobs resume; over-cap companions'
 * stay deferred; resumes carry the held parse (no re-parse).
 */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { resumeDeferredJobs } from './deferred-sweeper.js';
import type { ParsedDocument } from './parser.js';
import type { IngestionRunParams } from './pipeline.js';
import { IngestionRunner, type IngestionTarget } from './runner.js';

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

/** Quota fake: a companion's wallet is empty iff its id is in the set. */
class SetQuota implements VitalityStore {
  readonly overCompanions = new Set<string>();
  async getBalance(companionId: string): Promise<number> {
    return this.overCompanions.has(companionId) ? 0 : 1000;
  }
  async spend(): Promise<void> {}
  async add(): Promise<void> {}
  async isEmpty(companionId: string): Promise<boolean> {
    return this.overCompanions.has(companionId);
  }
}

const PARSED: ParsedDocument = { rawText: 'held', paragraphs: [{ ord: 1, text: 'held' }] };

describe('resumeDeferredJobs', () => {
  let semantic: DrizzleSemanticMemoryStore;
  let identity: DrizzleIdentityStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    semantic = new DrizzleSemanticMemoryStore(created.db);
    identity = new DrizzleIdentityStore(created.db);
  });
  afterEach(async () => {
    await close();
  });

  /** A companion owned by `email`, with one note source parked as `deferred`. */
  async function seedDeferredJob(
    email: string,
  ): Promise<{ ownerId: string; companionId: string; jobId: string }> {
    const user = await identity.ensureUserByEmail(email);
    const companion = await identity.createCompanion(user.id, {
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious',
    });
    const source = await semantic.createSource(companion.id, {
      kind: 'note',
      title: 'Parked',
      rawText: 'held',
    });
    const job = await semantic.createJob(companion.id, source.id);
    await semantic.updateJob(job.id, { status: 'deferred', parsedDoc: PARSED });
    return { ownerId: user.id, companionId: companion.id, jobId: job.id };
  }

  /** A runner whose fake target records resume runs and marks each job done. */
  function recordingRunner(): { runner: IngestionRunner; runs: IngestionRunParams[] } {
    const runs: IngestionRunParams[] = [];
    const target: IngestionTarget = {
      run: async (params) => {
        runs.push(params);
        await semantic.updateJob(params.jobId, { status: 'done', parsedDoc: null });
      },
    };
    return { runner: new IngestionRunner(target, silentLogger), runs };
  }

  it('resumes an under-cap owner’s parked job, carrying the held parse', async () => {
    const { jobId } = await seedDeferredJob('owner@example.com');
    const quota = new SetQuota(); // nobody over cap
    const { runner, runs } = recordingRunner();

    const resumed = await resumeDeferredJobs({
      semantic,
      quota,
      ingestion: runner,
      logger: silentLogger,
    });
    await runner.whenIdle();

    expect(resumed).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.jobId).toBe(jobId);
    expect(runs[0]!.resumeDocument).toEqual(PARSED);
    expect(runs[0]!.payload).toBeUndefined();
    expect(await semantic.listDeferredJobs()).toHaveLength(0);
  });

  it('leaves an over-cap companion’s job parked', async () => {
    const { companionId } = await seedDeferredJob('owner@example.com');
    const quota = new SetQuota();
    quota.overCompanions.add(companionId);
    const { runner, runs } = recordingRunner();

    const resumed = await resumeDeferredJobs({
      semantic,
      quota,
      ingestion: runner,
      logger: silentLogger,
    });
    await runner.whenIdle();

    expect(resumed).toBe(0);
    expect(runs).toHaveLength(0);
    expect(await semantic.listDeferredJobs()).toHaveLength(1);
  });

  it('resumes a parked job only once when two sweeps overlap', async () => {
    // Two sweeps racing on the same deferred job (a slow sweep overlapping the
    // 5-min timer tick) must not both enqueue it: the atomic claim lets exactly
    // one win, so the pipeline never runs the source — or spends its tokens —
    // twice.
    await seedDeferredJob('owner@example.com');
    const quota = new SetQuota(); // nobody over cap
    const { runner, runs } = recordingRunner();
    const sweep = (): Promise<number> =>
      resumeDeferredJobs({ semantic, quota, ingestion: runner, logger: silentLogger });

    const [a, b] = await Promise.all([sweep(), sweep()]);
    await runner.whenIdle();

    expect(a + b).toBe(1);
    expect(runs).toHaveLength(1);
    expect(await semantic.listDeferredJobs()).toHaveLength(0);
  });

  it('resumes only the under-cap companions when several are parked', async () => {
    const a = await seedDeferredJob('a@example.com');
    await seedDeferredJob('b@example.com');
    const quota = new SetQuota();
    quota.overCompanions.add(a.companionId); // a over cap, b under
    const { runner, runs } = recordingRunner();

    const resumed = await resumeDeferredJobs({
      semantic,
      quota,
      ingestion: runner,
      logger: silentLogger,
    });
    await runner.whenIdle();

    expect(resumed).toBe(1);
    expect(runs).toHaveLength(1);
    // a stays parked; b drained.
    const stillDeferred = await semantic.listDeferredJobs();
    expect(stillDeferred).toHaveLength(1);
    expect(stillDeferred[0]!.jobId).toBe(a.jobId);
  });
});
