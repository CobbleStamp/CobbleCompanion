/** The ingest job handler: fresh run from staged bytes, deferred resume, and the
 *  missing/interrupted guards (deliver-scalability.md §6 D-A). */

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logging.js';
import type { QueuedJob } from '../jobs/job-queue.js';
import type { IngestionRunContext } from '../memory/semantic-store.js';
import type { ParsedDocument } from './parser.js';
import type { IngestionRunParams } from './pipeline.js';
import type { StagedUpload } from './upload-staging.js';
import { makeIngestJobHandler } from './ingest-job.js';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

function job(payload: QueuedJob['payload']): QueuedJob {
  return {
    id: 'job-row',
    companionId: 'c1',
    type: 'ingest',
    dedupeKey: 'ingest:s1',
    payload,
    attempts: 0,
  };
}

interface Harness {
  runs: IngestionRunParams[];
  updates: { jobId: string; patch: unknown }[];
  deleted: string[];
}

function makeHandler(opts: { ctx: IngestionRunContext | null; staged?: StagedUpload | null }): {
  handler: ReturnType<typeof makeIngestJobHandler>;
  harness: Harness;
} {
  const harness: Harness = { runs: [], updates: [], deleted: [] };
  const handler = makeIngestJobHandler({
    pipeline: {
      run: async (params) => {
        harness.runs.push(params);
      },
    },
    semantic: {
      getRunContext: async () => opts.ctx,
      updateJob: async (jobId, patch) => {
        harness.updates.push({ jobId, patch });
      },
    },
    staging: {
      stage: async () => ({ id: 'unused' }),
      get: async () => opts.staged ?? null,
      delete: async (id) => {
        harness.deleted.push(id);
      },
      purgeExpired: async () => 0,
    },
    logger: silentLogger,
  });
  return { handler, harness };
}

const baseCtx = {
  companionId: 'c1',
  sourceId: 's1',
  sourceTitle: 'A Source',
  ownerId: 'u1',
};

describe('makeIngestJobHandler', () => {
  it('runs a fresh job from staged bytes, then deletes the staging row', async () => {
    const { handler, harness } = makeHandler({
      ctx: { ...baseCtx, status: 'queued', parsedDoc: null },
      staged: { id: 'up1', kind: 'note', bytes: new TextEncoder().encode('hello') },
    });
    await handler(job({ sourceId: 's1', jobId: 'job-row', uploadId: 'up1' }));

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]).toMatchObject({
      companionId: 'c1',
      sourceId: 's1',
      jobId: 'job-row',
      sourceTitle: 'A Source',
      ownerId: 'u1',
      payload: { kind: 'note', text: 'hello' },
    });
    expect(harness.deleted).toEqual(['up1']);
  });

  it('resumes a deferred job from its held parse, never touching staging', async () => {
    const parsedDoc: ParsedDocument = { rawText: 'held', paragraphs: [{ ord: 1, text: 'held' }] };
    const { handler, harness } = makeHandler({
      ctx: { ...baseCtx, status: 'deferred', parsedDoc },
    });
    await handler(job({ sourceId: 's1', jobId: 'job-row' }));

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.resumeDocument).toEqual(parsedDoc);
    expect(harness.runs[0]?.payload).toBeUndefined();
    expect(harness.deleted).toEqual([]);
  });

  it('no-ops when the source/job was deleted (null run context)', async () => {
    const { handler, harness } = makeHandler({ ctx: null });
    await handler(job({ sourceId: 's1', jobId: 'job-row', uploadId: 'up1' }));
    expect(harness.runs).toEqual([]);
    expect(harness.updates).toEqual([]);
  });

  it('skips a mid-pipeline (interrupted) job rather than re-running it', async () => {
    const { handler, harness } = makeHandler({
      ctx: { ...baseCtx, status: 'segmenting', parsedDoc: null },
      staged: { id: 'up1', kind: 'note', bytes: new TextEncoder().encode('x') },
    });
    await handler(job({ sourceId: 's1', jobId: 'job-row', uploadId: 'up1' }));
    expect(harness.runs).toEqual([]);
  });

  it('fails a fresh job whose staged upload is gone', async () => {
    const { handler, harness } = makeHandler({
      ctx: { ...baseCtx, status: 'queued', parsedDoc: null },
      staged: null,
    });
    await handler(job({ sourceId: 's1', jobId: 'job-row', uploadId: 'up1' }));
    expect(harness.runs).toEqual([]);
    expect(harness.updates).toEqual([
      {
        jobId: 'job-row',
        patch: { status: 'failed', error: expect.stringContaining('no longer available') },
      },
    ]);
  });

  it('ignores a job missing its references', async () => {
    const run = vi.fn();
    const { handler, harness } = makeHandler({
      ctx: { ...baseCtx, status: 'queued', parsedDoc: null },
    });
    await handler(job({}));
    expect(harness.runs).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
