/**
 * Deferred-sweeper tests against the real store + serial runner with a fake
 * pipeline target: under-cap owners' parked jobs resume; over-cap owners' stay
 * deferred; resumes carry the held parse (no re-parse).
 */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleSemanticMemoryStore } from '../memory/semantic-store.js';
import type { TokenQuotaStore, UsageSnapshot } from '../quota/store.js';
import { resumeDeferredJobs } from './deferred-sweeper.js';
import type { ParsedDocument } from './parser.js';
import type { IngestionRunParams } from './pipeline.js';
import { IngestionRunner, type IngestionTarget } from './runner.js';

const silentLogger = { error: () => undefined, info: () => undefined };

/** Quota fake: an owner is over cap iff its id is in the set. */
class SetQuota implements TokenQuotaStore {
  readonly overOwners = new Set<string>();
  async getUsage(): Promise<UsageSnapshot> {
    return { usedTokens: 0, capTokens: 1000, resetsAt: '2026-06-04T00:00:00.000Z' };
  }
  async recordUsage(): Promise<void> {}
  async isOverCap(userId: string): Promise<boolean> {
    return this.overOwners.has(userId);
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
  async function seedDeferredJob(email: string): Promise<{ ownerId: string; jobId: string }> {
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
    return { ownerId: user.id, jobId: job.id };
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

  it('leaves an over-cap owner’s job parked', async () => {
    const { ownerId } = await seedDeferredJob('owner@example.com');
    const quota = new SetQuota();
    quota.overOwners.add(ownerId);
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

  it('resumes only the under-cap owners when several are parked', async () => {
    const a = await seedDeferredJob('a@example.com');
    await seedDeferredJob('b@example.com');
    const quota = new SetQuota();
    quota.overOwners.add(a.ownerId); // a over cap, b under
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
